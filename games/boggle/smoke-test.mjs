// Headless smoke test for boggle — run with `node games/boggle/smoke-test.mjs`.
// Stubs the DOM and injects a small controlled dictionary (stand-in for
// words.js), evals game.js plus a driver in one scope, and checks board
// seeding, the solver, scoring, and the localStorage record keeping.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "game.js"), "utf8");

// the controlled dictionary the game will run against
const TEST_WORDS = [
	"cat", "cart", "carte", "carts", "teamster",
	"post", "stop", "pots", "opts", "tops", "spot", "tone", "note", "tones",
	"lard", "dart", "tart", "rate", "tear", "teal", "late", "tale", "stale",
	"least", "steal", "slate", "scale", "sale", "seal", "lean", "clean",
	"lost", "slot", "clot", "colt", "cold", "clod", "loot", "tool", "toot",
	"quiz", "quips", "quiet",
];

// ---- dom stubs ----

const mkClassList = () => ({
	_set: new Set(),
	add(c) {
		this._set.add(c);
	},
	remove(c) {
		this._set.delete(c);
	},
	toggle(c, on) {
		if (on) this._set.add(c);
		else this._set.delete(c);
	},
	contains(c) {
		return this._set.has(c);
	},
});

const mkEl = (tag) => {
	const el = {
		tagName: tag || "DIV",
		children: [],
		firstChild: null,
		textContent: "",
		disabled: false,
		className: "",
		classList: mkClassList(),
		listeners: {},
		addEventListener(type, fn) {
			(el.listeners[type] = el.listeners[type] || []).push(fn);
		},
		appendChild(child) {
			child.parentElement = el; // the drag handlers resolve dies by parent
			el.children.push(child);
			el.firstChild = el.children[0] || null;
			return child;
		},
	};
	Object.defineProperty(el, "innerHTML", {
		get() {
			return el._html || "";
		},
		set(v) {
			el._html = v;
			el.children = []; // mimic the browser clearing on assignment
			el.firstChild = null;
		},
	});
	return el;
};

const board = mkEl();
const share = mkEl("BUTTON");
const elements = {
	board,
	guess: mkEl(),
	hint: mkEl(),
	words: mkEl(),
	daystats: mkEl(),
	allstats: mkEl(),
	"date-label": mkEl(),
	"prev-day": mkEl("BUTTON"),
	"next-day": mkEl("BUTTON"),
	"key-back": mkEl("BUTTON"),
	"key-enter": mkEl("BUTTON"),
	overlay: mkEl(),
	"share-btn": share,
};

const store = new Map();
globalThis.localStorage = {
	getItem: (k) => (store.has(k) ? store.get(k) : null),
	setItem: (k, v) => {
		store.set(k, String(v));
	},
	removeItem: (k) => {
		store.delete(k);
	},
	key: (i) => [...store.keys()][i] ?? null,
	clear: () => {
		store.clear();
	},
	get length() {
		return store.size;
	},
};

globalThis.BOGGLE_WORDS = TEST_WORDS.join("\n");
const windowListeners = [];
globalThis.window = {
	addEventListener: (type, fn) => {
		windowListeners.push(fn);
	},
};
globalThis.document = {
	getElementById: (id) => {
		if (!elements[id]) throw new Error("missing element: " + id);
		return elements[id];
	},
	createElement: (tag) => mkEl(tag),
	// die index passed as the x coordinate keeps the drag tests lean
	elementFromPoint: (x) => board.children[Math.floor(x)] ?? null,
};

// ---- driver: appended to game.js so it shares scope ----

const driver = `
;(async () => {
	await readyPromise;

	// dates relative to the real today, so streak math is testable
	const dayOffset = (n) => {
		const d = new Date();
		d.setDate(d.getDate() - n);
		return fmtDate(d);
	};

	// T1: boards are determined by the date — stable for a given day,
	// distinct across days
	const b1 = boardForDate("2026-09-07");
	const b2 = boardForDate("2026-09-07");
	if (JSON.stringify(b1) !== JSON.stringify(b2)) throw new Error("T1: same date gives different boards");
	const key = (fs) => fs.map((f, i) => i + ":" + f).join("|");
	let overlaps = 0;
	for (let d = 0; d < 20; d++) {
		if (key(boardForDate("2026-09-07")) === key(boardForDate("2026-10-0" + ((d % 9) + 1)))) overlaps++;
	}
	if (overlaps === 20) throw new Error("T1: distinct dates give identical boards");
	console.log("T1 ok: date-seeded boards are stable and distinct");

	// T2: the solver — a hand-built board with known words
	//
	//   c a t d
	//   l a r e
	//   p o s t
	//   t o n e
	//
	// expected words verified by hand against the grid geometry; the
	// not-spellable list catches adjacency mistakes
	const known = ["c", "a", "t", "d", "l", "a", "r", "e", "p", "o", "s", "t", "t", "o", "n", "e"];
	const solved = solveBoard(known);
	for (const w of ["cat", "cart", "late", "rate", "lard", "tart", "tone", "tool", "loot", "post"]) {
		if (!solved.has(w)) throw new Error("T2: expected '" + w + "' to be solvable");
	}
	for (const w of ["team", "teal", "stop", "note", "seal", "lean", "quiz", "quiet", "quips"]) {
		if (solved.has(w)) throw new Error("T2: '" + w + "' can't be spelled on this board");
	}
	// independent brute force — no prefix pruning, no candidate
	// prefilter — the pruned solver must match it exactly
	const bruteSolve = (fs) => {
		const out = new Set();
		const walk = (ci, str, used) => {
			if (str.length >= MIN_WORD && DICT.has(str)) out.add(str);
			for (const ni of ADJ[ci]) {
				if (used & (1 << ni)) continue;
				walk(ni, str + fs[ni], used | (1 << ni));
			}
		};
		for (let i = 0; i < 16; i++) walk(i, fs[i], 1 << i);
		return out;
	};
	const brute = bruteSolve(known);
	for (const w of brute) {
		if (!solved.has(w)) throw new Error("T2: solver missed brute-force word '" + w + "'");
	}
	for (const w of solved) {
		if (!brute.has(w)) throw new Error("T2: solver invented word '" + w + "'");
	}
	console.log("T2 ok: solver matches brute force (" + solved.size + " words)");

	// T3: the qu die contributes two letters
	const quBoard = ["qu", "i", "z", "x", "x", "x", "x", "x", "x", "x", "x", "x", "x", "x", "x", "x"];
	const quSolved = solveBoard(quBoard);
	if (!quSolved.has("quiz")) throw new Error("T3: quiz must be findable on the qu board");
	if (quSolved.has("quips") || quSolved.has("quiet")) throw new Error("T3: distant dice shouldn't match");
	console.log("T3 ok: qu die contributes two letters");

	// T4: scoring table
	if (wordPoints("cat") !== 1) throw new Error("T4: 3 letters = 1 pt");
	if (wordPoints("cart") !== 1) throw new Error("T4: 4 letters = 1 pt");
	if (wordPoints("carts") !== 2) throw new Error("T4: 5 letters = 2 pts");
	if (wordPoints("teamsters") !== 11) throw new Error("T4: 9 letters = 11 pts");
	if (wordPoints("quiz") !== 1) throw new Error("T4: qu counts letters, quiz is 4");
	console.log("T4 ok: scoring table");

	// T5: records and streaks round-trip through localStorage
	saveRecord(dayOffset(2), { score: 10, words: 3, longest: "tone", won: true });
	saveRecord(dayOffset(1), { score: 20, words: 6, longest: "stale", won: true });
	saveRecord(dayOffset(0), { score: 15, words: 4, longest: "clean", won: true });
	let stats = loadStats();
	if (stats.played !== 3 || stats.wins !== 3 || stats.streak !== 3 || stats.best !== 20) {
		throw new Error("T5: stats wrong: " + JSON.stringify(stats));
	}
	// a lost today leaves the streak ending yesterday
	saveRecord(dayOffset(0), { score: 1, words: 1, longest: "cart", won: false });
	stats = loadStats();
	if (stats.streak !== 2) throw new Error("T5: streak should end before a lost day, got " + stats.streak);
	// an unplayed today still counts yesterday's run
	localStorage.removeItem("boggle:" + dayOffset(0));
	stats = loadStats();
	if (stats.streak !== 2) throw new Error("T5: unplayed today should keep yesterday's streak, got " + stats.streak);
	// a gap day breaks the run entirely
	localStorage.removeItem("boggle:" + dayOffset(1));
	stats = loadStats();
	if (stats.streak !== 0) throw new Error("T5: gap day should reset the streak, got " + stats.streak);
	localStorage.clear();
	console.log("T5 ok: records, wins, best, streaks");

	// T6: gameplay flow — start, submit words, finish, record saved,
	// practice runs can't overwrite. the date-rolled board is swapped
	// for the known board so the tiny test dictionary applies
	const setupKnown = (dayStr) => {
		initDay(dayStr);
		faces = known.slice();
		renderBoard();
		allWords = solveBoard(faces);
		par = Math.max(PAR_MIN, Math.round(allWords.size * PAR_FACTOR));
		found = new Set();
		score = 0;
		guess = "";
		sel = [];
		state = "ready";
		return loadRecord(dayStr);
	};
	const rec0 = setupKnown("2001-01-01");
	if (rec0) throw new Error("T6: day should start fresh");
	if (state !== "ready" || practice) throw new Error("T6: fresh day should be ready to play");
	startRun();
	if (state !== "run") throw new Error("T6: run should start");
	guess = "cart";
	submitGuess();
	if (!found.has("cart") || score !== 1) throw new Error("T6: submitting a word should score it");
	guess = "zzzz";
	submitGuess();
	if (found.has("zzzz") || score !== 1) throw new Error("T6: junk words must not score");
	guess = "cart";
	submitGuess();
	if (score !== 1) throw new Error("T6: duplicates must not double-score");
	endRun();
	const rec = loadRecord("2001-01-01");
	if (!rec || rec.words !== 1 || rec.score !== 1 || rec.won !== false) {
		throw new Error("T6: end of run should save the day's record: " + JSON.stringify(rec));
	}
	if (state !== "over") throw new Error("T6: run should be over");
	// same day again — practice — must not overwrite
	const recAgain = setupKnown("2001-01-01");
	if (recAgain.words !== 1) throw new Error("T6: record should persist across initDay");
	if (!practice) throw new Error("T6: replaying a scored day should be practice");
	startRun();
	guess = "cart";
	submitGuess();
	guess = "late";
	submitGuess();
	if (found.size !== 2 || score !== 2) throw new Error("T6: practice run should still score locally");
	endRun();
	const rec2 = loadRecord("2001-01-01");
	if (rec2.words !== 1 || rec2.score !== 1) throw new Error("T6: practice runs must not overwrite records");
	console.log("T6 ok: run flow, scoring, records, practice protection");

	// T7: the real keyboard path — every letter, including r, must
	// type during a run (a leftover game-restart guard once ate r's)
	const press = (key) => {
		for (const fn of windowListeners) fn({ key, preventDefault() {} });
	};
	initDay("2003-03-03");
	if (state !== "ready") throw new Error("T7: expected a ready day");
	press("x"); // any letter starts the run
	if (state !== "run") throw new Error("T7: a letter key should start the run");
	guess = "";
	sel = [];
	press("r");
	if (guess !== "r") throw new Error("T7: the letter r was swallowed mid-run — got '" + guess + "'");
	press("backspace");
	if (guess !== "") throw new Error("T7: backspace should clear the guess");
	endRun(); // leave no live timer — a stray interval would hang the test process
	console.log("T7 ok: keyboard path — letters type during a run");

	// T8: touch drag — slide through adjacent dice and release to
	// submit; plain taps keep tap-to-build; sliding back undoes
	initDay("2003-03-03");
	faces = known.slice();
	renderBoard();
	allWords = solveBoard(faces);
	par = Math.max(PAR_MIN, Math.round(allWords.size * PAR_FACTOR));
	found = new Set();
	score = 0;
	guess = "";
	sel = [];
	updateDeadDice(); // refresh deadness for the swapped-in board
	state = "ready";
	startRun();
	const fireTouch = (type, x) => {
		for (const fn of boardEl.listeners[type] || []) {
			fn({
				touches: [{ clientX: x, clientY: 0 }],
				changedTouches: [{ clientX: x, clientY: 0 }],
				cancelable: true,
				preventDefault() {},
			});
		}
	};
	// drag c(0) → a(1) → r(6) → t(2): "cart", released → submitted
	fireTouch("touchstart", 0);
	if (state !== "run" || sel.length !== 1 || sel[0] !== 0) throw new Error("T8: touchstart should select and start the run");
	fireTouch("touchmove", 1);
	fireTouch("touchmove", 6);
	if (guess !== "car") throw new Error("T8: dragging should build 'car', got '" + guess + "'");
	fireTouch("touchmove", 0); // r(6) → t(2) is legal, but try an illegal jump first: 6 → 0 is not adjacent
	if (guess !== "car") throw new Error("T8: illegal jumps must be ignored");
	fireTouch("touchmove", 2);
	if (guess !== "cart") throw new Error("T8: dragging should build 'cart'");
	fireTouch("touchend", 0);
	if (guess !== "" || !found.has("cart") || score !== 1) throw new Error("T8: release should submit the dragged word");
	// sliding back undoes: c(0) → a(1) → t(2), back to a(1), out to t(2)
	guess = "";
	sel = [];
	fireTouch("touchstart", 0);
	fireTouch("touchmove", 1);
	fireTouch("touchmove", 2);
	if (guess !== "cat") throw new Error("T8: drag should build 'cat'");
	fireTouch("touchmove", 1); // slide back onto the previous die
	if (sel.length !== 2 || guess !== "ca") throw new Error("T8: sliding back should undo a step, got '" + guess + "'");
	fireTouch("touchmove", 2);
	fireTouch("touchend", 0); // release submits
	if (guess !== "" || !found.has("cat") || score !== 2) throw new Error("T8: slide-back then release should score 'cat'");
	// plain tap (no slide) on an adjacent die extends the selection
	guess = "";
	sel = [];
	fireTouch("touchstart", 0); // select c
	fireTouch("touchend", 0); // no movement — tap semantics: dieClick(0) on empty selection
	if (guess !== "c" || sel.length !== 1) throw new Error("T8: plain tap should select the die, got '" + guess + "'");
	fireTouch("touchstart", 1); // preSel is [0], touch a(1)
	fireTouch("touchend", 1); // tap → dieClick(1) with sel [0]: adjacent, appends
	if (guess !== "ca" || sel.length !== 2) throw new Error("T8: tap after tap should extend the path, got '" + guess + "'");
	// touchcancel puts things back untouched
	const holdSel = sel.slice();
	fireTouch("touchstart", 6);
	fireTouch("touchmove", 6); // extends the path mid-drag...
	fireTouch("touchcancel", 6);
	if (sel.length !== holdSel.length) throw new Error("T8: cancelled drag should restore the selection");
	endRun(); // stop the run's timer
	console.log("T8 ok: drag, slide-back, taps, cancel");

	// T9: dead dice — once every word spellable through a die is found,
	// the die grays out. on the known board, d(3) only spells "lard";
	// c(0) spells cat, cart, carte, carts, and clot
	initDay("2006-06-06");
	faces = known.slice();
	renderBoard();
	allWords = solveBoard(faces);
	found = new Set();
	score = 0;
	guess = "";
	sel = [];
	state = "ready";
	startRun();
	updateDeadDice();
	const dies = dieEls();
	if (dies[3].classList.contains("dead")) throw new Error("T9: d die starts alive while lard is unfound");
	if (dies[0].classList.contains("dead")) throw new Error("T9: c die starts alive");
	guess = "lard";
	submitGuess();
	if (!found.has("lard")) throw new Error("T9: lard should have submitted");
	if (!dies[3].classList.contains("dead")) throw new Error("T9: d die should gray after lard — its only word");
	if (dies[0].classList.contains("dead")) throw new Error("T9: c die must stay alive while its words are unfound");
	const cWords = ["cat", "cart", "carte", "carts", "clot"];
	for (let i = 0; i < cWords.length; i++) {
		guess = cWords[i];
		submitGuess();
		if (!found.has(cWords[i])) throw new Error("T9: expected to submit '" + cWords[i] + "'");
		const isLast = i === cWords.length - 1;
		if (dies[0].classList.contains("dead") !== isLast) {
			throw new Error("T9: c die deadness wrong after " + cWords[i]);
		}
	}
	endRun(); // stops the timer
	console.log("T9 ok: dead dice track exhausted letters");

	// T10: dead dice refuse to join words — via drag, tap, and typing
	initDay("2007-07-07");
	faces = known.slice();
	renderBoard();
	allWords = solveBoard(faces);
	found = new Set();
	score = 0;
	guess = "";
	sel = [];
	state = "ready";
	startRun();
	guess = "lard";
	submitGuess();
	if (!found.has("lard")) throw new Error("T10: lard should submit");
	// drag c-a-r, then over the dead d(3) — must not extend
	fireTouch("touchstart", 0);
	fireTouch("touchmove", 1);
	fireTouch("touchmove", 6);
	fireTouch("touchmove", 3); // dead die adjacent to r — refused
	if (guess !== "car") throw new Error("T10: drag must skip dead dice, got '" + guess + "'");
	fireTouch("touchmove", 2); // live die adjacent to r — still works
	if (guess !== "cart") throw new Error("T10: live extension after a dead die should work");
	fireTouch("touchend", 0);
	if (!found.has("cart")) throw new Error("T10: cart should submit after the dead-skip drag");
	// dragging FROM a dead die stays inert and doesn't phantom-select
	guess = "";
	sel = [];
	fireTouch("touchstart", 3); // dead d
	fireTouch("touchmove", 2); // live t — but the drag is inert
	if (guess !== "") throw new Error("T10: dragging from a dead die must not build, got '" + guess + "'");
	fireTouch("touchend", 2);
	if (guess !== "") throw new Error("T10: releasing an inert drag must not tap-select");
	// tapping a dead die does nothing
	fireTouch("touchstart", 3);
	fireTouch("touchend", 3);
	if (guess !== "") throw new Error("T10: tapping a dead die must not select");
	// typing reroutes around dead dice: "lard" is found, its only d is dead
	if (matchWord("lard")) throw new Error("T10: matchWord must not route through dead dice");
	endRun(); // stops the timer
	console.log("T10 ok: dead dice refused by drag, tap, and typing");

	console.log("SMOKE OK");
})().catch((e) => {
	console.error("SMOKE FAILED:", e.message);
	console.error(e.stack);
	process.exit(1);
});
`;

eval(source + "\n" + driver);
