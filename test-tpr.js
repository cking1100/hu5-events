import test from "node:test";
import assert from "node:assert/strict";
import { parseTPRSchedules } from "./tpr-schedules.js";

const website = `<div class="textwidget">
<div><strong>The Quiz.</strong></div>
<div>Bob's Big Brain Quiz <a>#BBBQ</a><br>Hull's most cleverest, most stupidest quiz.<br>Every Sunday (except bank holidays). Starts at 20:00. Free entry. Prizes. Foolishness.</div>
<div><strong>TPR DJ Nights.</strong></div>
<div>"Hip Hop Hooray!" - Live hip hop craziness featuring beatboxing.</div>
<div>For all the latest dates, check out Facebook.</div>
<div><b>Live@The Peoples</b></div>
<div>There is live music every Thursday from 8pm, and occasional gigs on other days...</div>
</div>`;

test("TPR extracts both published schedules without inventing dated DJ events", () => {
  const events = parseTPRSchedules(website);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.title), ["Bob's Big Brain Quiz", "Live@The Peoples"]);
  assert.equal(events[0].dateText, "Every Sunday (except bank holidays)");
  assert.equal(events[0].timeText, "20:00");
  assert.equal(events[0].freeEntry, true);
  assert.equal(events[1].dateText, "every Thursday");
  assert.equal(events[1].timeText, "8pm");
  assert.equal(events[1].freeEntry, false);
});

test("TPR does not fabricate schedules when the source removes them", () => {
  assert.deepEqual(parseTPRSchedules("<div class='textwidget'>Opening Times: Sunday 14:00</div>"), []);
  assert.equal(parseTPRSchedules(website.replace("every Thursday from 8pm", "occasional live music")).length, 1);
});