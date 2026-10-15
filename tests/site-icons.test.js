import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as cheerio from "cheerio";

const publicRoot = new URL("../public/", import.meta.url);

test("browser and installed app icons resolve to HU5 assets with correct sizes", async () => {
  const $ = cheerio.load(await readFile(new URL("index.html", publicRoot), "utf8"));
  const svg = await readFile(new URL("favicon.svg", publicRoot), "utf8");
  assert.match(svg, /aria-label="HU5 Events"/);
  assert.match(svg, /<rect[^>]+fill="#00d4ff"/);
  assert.match(svg, /<path[^>]+fill="#000000"/);
  assert.doesNotMatch(svg, /sp[aä]ti/i);
  for (const [name, size] of [["favicon.png", 32], ["apple-touch-icon.png", 180], ["logo.png", 512]]) {
    const png = await readFile(new URL(name, publicRoot));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const links = $('link[rel="icon"], link[rel="apple-touch-icon"]').toArray();
  assert.equal(links.length, 3);
  for (const link of links) {
    const url = new URL($(link).attr("href"), "https://www.findhu5.events");
    assert.equal(url.searchParams.get("v"), "hu5-blue-20261015");
    await readFile(new URL(url.pathname.slice(1), publicRoot));
  }
  const manifest = JSON.parse(await readFile(new URL("site.webmanifest", publicRoot), "utf8"));
  for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap(shortcut => shortcut.icons)]) {
    assert.equal(icon.sizes, "512x512");
    assert.equal(new URL(icon.src, "https://www.findhu5.events").pathname, "/logo.png");
  }
});
