// USB preflight passes only layout metadata. Publication checks the same rule
// against data partitions already promised by this application's releases.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkUpgrade, TABLE_OFFSET } from "../src/lib/pp/upgrade.mjs";

const md5 = bytes => createHash("md5").update(bytes).digest("hex");
try {
  const [candidate, ...previous] = process.argv.slice(2);
  if (candidate) {
    const manifest = JSON.parse(readFileSync(join(candidate, "manifest.json"), "utf8"));
    const parts = manifest.flash_files.map(row => ({address: Number(row.offset), size: row.bytes}));
    const table = readFileSync(join(candidate, manifest.flash_files.find(row => Number(row.offset) === TABLE_OFFSET).file));
    checkUpgrade(table, table, parts, md5, false, manifest.upgrade_policy);
    for (const file of previous) checkUpgrade(readFileSync(file), table, parts, md5, false, manifest.upgrade_policy);
  } else {
    const {current, target, parts, blankChip, policy} = JSON.parse(readFileSync(0, "utf8"));
    console.log(JSON.stringify(checkUpgrade(Buffer.from(current, "hex"), Buffer.from(target, "hex"), parts, md5, blankChip, policy)));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
