"""Shared session lifecycle and protocol capacity regression."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from pp_sessions import IDLE_ENDED, REPLACED_ENDED, SessionError, Sessions


class Machine:
    meta = {"version": "test"}

    def __init__(self):
        self.closed = False

    async def invoke(self, method):
        return {"ui": {"text": "界面"}, "screen": "frame", "serial": "log"}[method]

    async def close(self):
        self.closed = True


class Lab:
    @staticmethod
    def image(image):
        return (image,)


class Engine:
    async def boot(self, _image):
        return Machine()


class SessionCapacity(unittest.IsolatedAsyncioTestCase):
    async def test_lru_and_busy(self):
        pool = Sessions(Lab(), Engine(), 5)
        self.addAsyncCleanup(pool.close)
        rooms = [await pool.create("release:test") for _ in range(5)]
        rooms[0].peers.add(asyncio.Event())
        rooms[1].busy = True
        replacement = await pool.create("release:test")
        self.assertTrue(rooms[2].machine.closed)
        self.assertEqual(len(pool.items), 5)
        with self.assertRaisesRegex(SessionError, "不存在"):
            pool.get(rooms[2].ident)
        for room in (rooms[3], rooms[4], replacement):
            room.peers.add(asyncio.Event())
        with self.assertRaisesRegex(SessionError, "都在使用"):
            await pool.create("release:test")

    async def test_unlimited_and_private_image(self):
        pool = Sessions(Lab(), Engine(), 0)
        self.addAsyncCleanup(pool.close)
        with self.assertRaises(SessionError):
            await pool.create("candidate:test", public=True)
        rooms = [await pool.create("release:test") for _ in range(6)]
        self.assertEqual(len(pool.items), 6)
        self.assertFalse(any(room.machine.closed for room in rooms))

    async def test_connected_idle_session_expires_even_without_a_capacity_limit(self):
        pool = Sessions(Lab(), Engine(), 0)
        self.addAsyncCleanup(pool.close)
        with patch("pp_sessions.monotonic", return_value=100):
            room = await pool.create("release:test")
            peer = asyncio.Event()
            room.peers.add(peer)
        with patch("pp_sessions.monotonic", return_value=100 + 23 * 3600):
            await room.command(peer, "ui", {})
            await pool.expire()
            self.assertIs(pool.get(room.ident), room)
        with patch("pp_sessions.monotonic", return_value=100 + 24 * 3600):
            with self.assertRaisesRegex(SessionError, IDLE_ENDED):
                pool.get(room.ident)
            await pool.expire()
            self.assertTrue(room.machine.closed)
            self.assertTrue(peer.is_set())
            self.assertEqual(room.closed_message, IDLE_ENDED)
            self.assertNotIn(room.ident, pool.items)

    async def test_access_renews_and_active_execution_defers_expiry(self):
        pool = Sessions(Lab(), Engine(), 5, idle_timeout=60)
        self.addAsyncCleanup(pool.close)
        with patch("pp_sessions.monotonic", return_value=100):
            room = await pool.create("release:test")
        with patch("pp_sessions.monotonic", return_value=159):
            await room.command(None, "clock", {"op": "pause"})
        with patch("pp_sessions.monotonic", return_value=160):
            await pool.expire()
            self.assertIs(pool.get(room.ident), room)
        with patch("pp_sessions.monotonic", return_value=219):
            room.busy = True
            await pool.expire()
            self.assertIs(pool.get(room.ident), room)
            room.busy = False
            await pool.expire()
            self.assertTrue(room.machine.closed)

    async def test_wait_queue_observes_order_and_disconnect(self):
        pool = Sessions(Lab(), Engine(), 1)
        self.addAsyncCleanup(pool.close)
        room = await pool.create("release:test")
        room.peers.add(asyncio.Event())
        first_position, second_position = asyncio.Queue(), asyncio.Queue()
        first = asyncio.create_task(pool.wait_for_room("release:first", first_position.put))
        second = asyncio.create_task(pool.wait_for_room("release:second", second_position.put))
        try:
            self.assertEqual(await asyncio.wait_for(first_position.get(), 1), 1)
            self.assertEqual(await asyncio.wait_for(second_position.get(), 1), 2)
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)
            self.assertEqual(await asyncio.wait_for(second_position.get(), 2), 1)
            self.assertFalse(second.done())
            pool.remove(room)
            await room.close()
            created = await asyncio.wait_for(second, 2)
            self.assertEqual(created.image, "release:second")
            self.assertTrue(created.rejoin_until)
            self.assertFalse(pool.waiters)
        finally:
            first.cancel()
            second.cancel()
            await asyncio.gather(first, second, return_exceptions=True)

    async def test_replace_targets_oldest_activity_and_stops_running_job(self):
        pool = Sessions(Lab(), Engine(), 3)
        self.addAsyncCleanup(pool.close)
        rooms = [await pool.create("release:test") for _ in range(3)]
        for room in rooms:
            room.peers.add(asyncio.Event())
        rooms[0].touch()
        oldest = rooms[1]
        oldest.busy = True
        oldest.job = asyncio.create_task(asyncio.Event().wait())
        with self.assertRaises(SessionError) as refused:
            await pool.create("release:test")
        self.assertEqual(refused.exception.code, "capacity")
        await pool.create("release:new", public=True, replace=True)
        self.assertTrue(oldest.job.cancelled())
        self.assertTrue(oldest.machine.closed)
        self.assertEqual(oldest.closed_message, REPLACED_ENDED)
        self.assertFalse(rooms[0].closed or rooms[2].closed)
        self.assertEqual(len(pool.items), 3)
        with self.assertRaisesRegex(SessionError, REPLACED_ENDED):
            pool.get(oldest.ident)


if __name__ == "__main__":
    unittest.main()
