"""Shared session lifecycle and protocol capacity regression."""
import asyncio
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from pp_sessions import (
    DEVELOPMENT_WAITING, IDLE_ENDED, REPLACED_ENDED, SessionError, Sessions, control_app,
    next_session_id, public_app,
)


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
    async def asyncSetUp(self):
        state = TemporaryDirectory()
        self.addCleanup(state.cleanup)
        self.sequence = Path(state.name) / "session-ids.sqlite3"

    def pool(self, limit, **options):
        return Sessions(Lab(), Engine(), limit, sequence_path=self.sequence, **options)

    async def test_concurrent_allocation_and_service_restart_keep_incrementing(self):
        pool = self.pool(0)
        self.addAsyncCleanup(pool.close)
        rooms = await asyncio.gather(*(pool.create("release:test") for _ in range(3)))
        self.assertEqual([room.ident for room in rooms], [1, 2, 3])
        await pool.close()
        allocated = await asyncio.gather(*(asyncio.to_thread(next_session_id, self.sequence) for _ in range(4)))
        self.assertEqual(sorted(allocated), [4, 5, 6, 7])
        restarted = self.pool(0)
        self.addAsyncCleanup(restarted.close)
        self.assertEqual((await restarted.create("release:test")).ident, 8)

    async def test_browser_requires_key_and_local_control_takes_numeric_id(self):
        pool = self.pool(0)
        self.addAsyncCleanup(pool.close)
        async with TestClient(TestServer(public_app(pool))) as client:
            headers = {"Origin": str(client.make_url("/").origin()), "X-Forwarded-Proto": "http"}
            async with client.post("/sessions", json={"image": "release:test"}, headers=headers) as response:
                self.assertEqual(response.status, 201)
                share = await response.json()
            self.assertIs(type(share["session"]), int)
            self.assertRegex(share["key"], r"^[a-f0-9]{48}$")
            first = share["key"][0]
            wrong = ("1" if first == "0" else "0") + share["key"][1:]
            for hello in ({"session": share["session"]}, {**share, "key": wrong}, {**share, "session": True}):
                async with client.ws_connect("/session", headers=headers) as socket:
                    await socket.send_json(hello)
                    self.assertEqual(await socket.receive_json(timeout=2), {
                        "type": "ended", "message": "会话不存在或已结束",
                    })
            async with client.ws_connect("/session", headers=headers) as socket:
                await socket.send_json(share)
                snapshot = await socket.receive_json(timeout=2)
                self.assertEqual(snapshot["type"], "state")
                self.assertNotIn("key", snapshot)
        async with TestClient(TestServer(control_app(pool))) as client:
            async with client.get(f'/sessions/{share["session"]}') as response:
                self.assertEqual(response.status, 200)
            async with client.get(f'/sessions/0{share["session"]}') as response:
                self.assertEqual(response.status, 404)

    async def test_development_slot_survives_capacity_and_expiry(self):
        pool = self.pool(1, idle_timeout=60)
        self.addAsyncCleanup(pool.close)
        with patch("pp_sessions.monotonic", return_value=100):
            normal = await pool.create("release:test")
            normal.peers.add(asyncio.Event())
            development = await pool.create_development("candidate:ai")
            self.assertEqual(development.ident, 0)
            self.assertEqual(normal.ident, 1)
            self.assertFalse(pool.has_capacity())
            replacement = await pool.create("release:new", public=True, replace=True)
            self.assertEqual(replacement.ident, 2)
            self.assertTrue(normal.machine.closed)
            self.assertIs(pool.get(0), development)
            with self.assertRaisesRegex(SessionError, "保留"):
                pool.remove(development, replace=True)
        with patch("pp_sessions.monotonic", return_value=161):
            await pool.expire()
            self.assertIs(pool.get(0), development)
            self.assertFalse(development.machine.closed)
            self.assertTrue(replacement.machine.closed)

    async def test_development_link_waits_and_reconnects_to_new_firmware(self):
        pool = self.pool(0)
        self.addAsyncCleanup(pool.close)
        link = pool.development_share()
        self.assertEqual(link["session"], 0)
        async with (
            TestClient(TestServer(public_app(pool))) as browser,
            TestClient(TestServer(control_app(pool))) as local,
        ):
            headers = {"Origin": str(browser.make_url("/").origin()), "X-Forwarded-Proto": "http"}
            async with local.get("/development") as response:
                self.assertEqual(await response.json(), link)
            async with browser.ws_connect("/session", headers=headers) as socket:
                await socket.send_json({"session": 0})
                self.assertEqual((await socket.receive_json(timeout=2))["type"], "ended")
            async with browser.ws_connect("/session", headers=headers) as socket:
                await socket.send_json(link)
                self.assertEqual(await socket.receive_json(timeout=2), {
                    "type": "waiting", "message": DEVELOPMENT_WAITING,
                })

            async with local.post("/development", json={"image": "candidate:first"}) as response:
                self.assertEqual(response.status, 201)
                first = await response.json()
            self.assertEqual({name: first[name] for name in link}, link)
            original = pool.get(0)
            original.busy = True
            with self.assertRaisesRegex(SessionError, "正在验收"):
                await pool.create_development("candidate:blocked")
            original.busy = False
            async with local.delete("/sessions/0") as response:
                self.assertEqual(response.status, 409)
            with patch.object(pool.engine, "boot", side_effect=RuntimeError("failed boot")):
                with self.assertRaisesRegex(SessionError, "failed boot"):
                    await pool.create_development("candidate:broken")
            self.assertIs(pool.get(0), original)

            async with browser.ws_connect("/session", headers=headers) as socket:
                await socket.send_json(link)
                self.assertEqual((await socket.receive_json(timeout=2))["type"], "state")
                await socket.send_json({"id": 1, "cmd": "end"})
                self.assertIn("保留", (await socket.receive_json(timeout=2))["err"])
                second = await pool.create_development("candidate:second")
                self.assertEqual(second.share(), link)
                self.assertNotEqual(second.generation, first["generation"])
                self.assertTrue(original.machine.closed)
                self.assertEqual((await socket.receive_json(timeout=2))["type"], "waiting")
            async with local.get("/sessions/0", params={"generation": first["generation"]}) as response:
                self.assertEqual(response.status, 409)
            async with browser.ws_connect("/session", headers=headers) as socket:
                await socket.send_json(link)
                self.assertEqual((await socket.receive_json(timeout=2))["type"], "state")

        await pool.close()
        restarted = self.pool(0)
        self.addAsyncCleanup(restarted.close)
        self.assertEqual(restarted.development_share(), link)
        with self.assertRaisesRegex(SessionError, DEVELOPMENT_WAITING):
            restarted.get(0, key=link["key"])

    async def test_lru_and_busy(self):
        pool = self.pool(5)
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
        pool = self.pool(0)
        self.addAsyncCleanup(pool.close)
        with self.assertRaises(SessionError):
            await pool.create("candidate:test", public=True)
        rooms = [await pool.create("release:test") for _ in range(6)]
        self.assertEqual(len(pool.items), 6)
        self.assertFalse(any(room.machine.closed for room in rooms))

    async def test_connected_idle_session_expires_even_without_a_capacity_limit(self):
        pool = self.pool(0)
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
        pool = self.pool(5, idle_timeout=60)
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
        pool = self.pool(1)
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
        pool = self.pool(3)
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
        with self.assertRaisesRegex(SessionError, REPLACED_ENDED):
            pool.get(oldest.ident, key=oldest.access_key)
        with self.assertRaisesRegex(SessionError, "会话不存在或已结束"):
            pool.get(oldest.ident, key=rooms[0].access_key)


if __name__ == "__main__":
    unittest.main()
