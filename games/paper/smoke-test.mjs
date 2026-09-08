// Headless smoke test for paper — run with `node games/paper/smoke-test.mjs`.
// Stubs the DOM, evals game.js plus a driver in one scope, checks the
// capture rules against constructed scenarios, then plays a few full
// games with random input and asserts world invariants throughout.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "game.js"), "utf8");

// ---- dom stubs ----

const ctxStub = () =>
	new Proxy(
		{},
		{
			get: (t, prop) => {
				if (prop === "canvas") return { width: 0, height: 0 };
				return () => undefined;
			},
			set: () => true,
		}
	);

const mkCanvas = () => ({
	width: 0,
	height: 0,
	style: {},
	parentElement: { clientWidth: 616 },
	getContext: () => ctxStub(),
	addEventListener: () => {},
});

const mkEl = () => {
	const el = {
		children: [],
		innerHTML: "",
		firstChild: null,
		style: {},
		classList: { add() {}, remove() {}, contains: () => false },
		appendChild(child) {
			el.children.push(child);
			el.firstChild = el.children[0];
		},
		removeChild(child) {
			const i = el.children.indexOf(child);
			if (i >= 0) el.children.splice(i, 1);
			el.firstChild = el.children[0] || null;
		},
		addEventListener: () => {},
	};
	return el;
};

const elements = {
	game: mkCanvas(),
	minimap: mkCanvas(),
	overlay: mkEl(),
	standings: mkEl(),
	feed: mkEl(),
};

globalThis.simTime = 0;
globalThis.requestAnimationFrame = () => 1;
globalThis.performance = { now: () => globalThis.simTime };
globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
globalThis.document = {
	getElementById: (id) => {
		if (!elements[id]) throw new Error("missing element: " + id);
		return elements[id];
	},
	createElement: (tag) => (tag === "canvas" ? mkCanvas() : mkEl()),
};

// ---- driver: appended to game.js so it shares scope ----

const driver = `
;(() => {
	const GRID2 = GRID;
	const cell = (x, y) => y * GRID2 + x;

	const realKill = kill;
	let deaths = [];
	kill = (p, cause, killer) => {
		deaths.push({ who: p.name, bot: p.isBot, cause, by: killer ? killer.name : null, t: Math.round(globalThis.simTime / 1000) });
		realKill(p, cause, killer);
	};

	const checkInvariants = () => {
		const countOwner = (id) => {
			let n = 0;
			for (let i = 0; i < GRID2 * GRID2; i++) if (owner[i] === id) n++;
			return n;
		};
		for (let id = 0; id < players.length; id++) {
			if (counts[id] !== countOwner(id)) throw new Error("counts mismatch for player " + id);
		}
		const marked = new Set();
		for (const p of players) {
			for (const ci of p.trailCells) {
				if (trail[ci] !== p.id) throw new Error("trailCells entry without mark at " + ci);
				if (marked.has(ci)) throw new Error("duplicate trail cell " + ci);
				marked.add(ci);
			}
		}
		for (let i = 0; i < GRID2 * GRID2; i++) {
			if (trail[i] >= 0 && !marked.has(i)) throw new Error("stale trail mark at " + i);
		}
	};

	// shared scenario: you's base west, cron's big base east, and a ring
	// wall enclosing cols 41..51 / rows 39..61 through cron's land
	const cutScenario = (victimHead, victimTrail) => {
		owner.fill(-1);
		trail.fill(-1);
		counts = new Array(players.length).fill(0);
		for (const p of players) {
			p.alive = p.id < 2; // only you + cron take part
			p.trailCells = [];
			p.kills = 0;
			p.px = p.x;
			p.py = p.y;
		}
		const rect = (x0, y0, x1, y1, id) => {
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) owner[cell(x, y)] = id;
			counts[id] += (x1 - x0 + 1) * (y1 - y0 + 1);
		};
		rect(30, 40, 50, 60, 1);
		rect(8, 48, 12, 52, 0);
		players[0].x = players[0].px = 12;
		players[0].y = players[0].py = 50;
		players[1].x = players[1].px = victimHead[0];
		players[1].y = players[1].py = victimHead[1];
		if (victimTrail) {
			for (const [tx, ty] of victimTrail) {
				const ci = cell(tx, ty);
				trail[ci] = 1;
				players[1].trailCells.push(ci);
			}
		}
		players[0].trailCells = [];
		const addTrail = (x, y) => {
			const ci = cell(x, y);
			if (owner[ci] === 0) return;
			trail[ci] = 0;
			players[0].trailCells.push(ci);
		};
		for (let y = 39; y <= 61; y++) addTrail(40, y);
		for (let x = 40; x <= 51; x++) addTrail(x, 39);
		for (let y = 39; y <= 61; y++) addTrail(51, y);
		for (let x = 40; x <= 51; x++) addTrail(x, 61);
		capture(players[0]);
		checkInvariants();
	};

	// rule checks — see the header comment in game.js for the ruleset
	cutScenario([35, 50], null);
	if (!players[1].alive) throw new Error("T1: victim died but head was outside the cut");
	if (owner[cell(45, 50)] !== 0) throw new Error("T1: enclosed side should become capturer's");
	if (owner[cell(35, 50)] !== 1) throw new Error("T1: head side should stay victim's");
	console.log("T1 ok: enclosed enemy land taken over, head side kept");

	cutScenario([45, 50], null);
	if (!players[1].alive) throw new Error("T2: victim should survive standing in the pocket");
	if (owner[cell(45, 50)] !== 1) throw new Error("T2: pocket with head should stay victim's");
	if (owner[cell(35, 50)] !== 1) throw new Error("T2: contiguous far base should stay");
	console.log("T2 ok: pocket kept for standing victim, contiguous far base kept");

	cutScenario([35, 50], [[45, 50], [46, 50]]);
	if (players[1].alive) throw new Error("T3: victim with buried trail should die");
	if (players[0].kills !== 1) throw new Error("T3: capturer should get the kill");
	if (owner[cell(46, 55)] !== 0) throw new Error("T3: enclosed side should become capturer's");
	if (owner[cell(35, 50)] !== -1) throw new Error("T3: dead victim's land should crumble");
	console.log("T3 ok: buried trail cut its owner down, remains crumbled");

	// full games: a mediocre-but-not-suicidal player and random input;
	// players[0] is AI-driven in the second batch
	const randomSafeDir = (p) => {
		const opts = [];
		for (let d = 0; d < 4; d++) {
			if (!deadly(p, p.x + DX[d], p.y + DY[d])) opts.push(d);
		}
		return opts.length ? opts[(Math.random() * opts.length) | 0] : p.dir;
	};
	const playerPolicy = () => {
		const you = players[0];
		if (!you.alive) return;
		if (you.trailCells.length === 0) {
			if (Math.random() < 0.04) queueDir(randomSafeDir(you));
			return;
		}
		if (you.trailCells.length > 10 || (you.trailCells.length > 4 && Math.random() < 0.02)) {
			const next = bfsHome(you);
			if (next !== -1) queueDir(dirFromTo(you.x, you.y, next % GRID2, (next / GRID2) | 0));
			return;
		}
		if (Math.random() < 0.25) queueDir(randomSafeDir(you));
	};

	console.log("--- humanish player games ---");
	const botCauses = {};
	for (let g = 0; g < 4; g++) {
		deaths = [];
		initWorld();
		startGame();
		let frames = 0;
		while (state !== "over" && frames < 120_000) {
			globalThis.simTime += 16.7;
			playerPolicy();
			frame(globalThis.simTime);
			frames++;
			if (frames % 311 === 0) checkInvariants();
		}
		checkInvariants();
		if (state !== "over") throw new Error("humanish game " + g + " never ended");
		for (const d of deaths) if (d.bot) botCauses[d.cause] = (botCauses[d.cause] || 0) + 1;
		const yourDeath = deaths.find((d) => d.who === "you");
		console.log(JSON.stringify({
			g: g + 1,
			secs: Math.round(globalThis.simTime / 1000),
			outcome: counts[0] / (GRID2 * GRID2) >= 0.25 ? "you-win(25%)"
				: players.filter((p) => p.alive).length === 1 && players[0].alive ? "you-win(last)"
				: "you-died",
			youDiedTo: yourDeath ? yourDeath.cause + (yourDeath.by ? "(by " + yourDeath.by + ")" : "") : "-",
		}));
	}
	for (const cause of Object.keys(botCauses)) {
		if (cause === "self" || cause === "wall") throw new Error("bots suiciding: " + cause + " x" + botCauses[cause]);
	}
	console.log("bot death causes: " + JSON.stringify(botCauses));

	console.log("--- all-AI games ---");
	for (let g = 0; g < 2; g++) {
		deaths = [];
		initWorld();
		startGame();
		players[0].isBot = true; // after startGame — initWorld resets it
		let frames = 0;
		while (state !== "over" && frames < 240_000) {
			globalThis.simTime += 16.7;
			frame(globalThis.simTime);
			frames++;
			if (frames % 311 === 0) checkInvariants();
		}
		checkInvariants();
		if (state !== "over") throw new Error("all-AI game " + g + " never ended");
		const w = players.find((p) => p.alive && counts[p.id] / (GRID2 * GRID2) >= 0.25)
			|| players.filter((p) => p.alive)[0];
		console.log(JSON.stringify({
			g: g + 1,
			secs: Math.round(globalThis.simTime / 1000),
			winner: w ? w.name : "draw",
			pcts: players.map((p) => p.name + "=" + (counts[p.id] / (GRID2 * GRID2) * 100).toFixed(1)).join(" "),
		}));
	}
	console.log("SMOKE OK");
})();
`;

// ---- run ----

try {
	eval(source + "\n" + driver);
} catch (err) {
	console.error("SMOKE FAILED:", err.message);
	console.error((err.stack || "").split("\n").slice(0, 8).join("\n"));
	process.exit(1);
}
