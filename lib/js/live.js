/*
 * Public live page: poll, render, goal timeline.
 *
 * Polling rather than websockets is a deliberate call. Scoring events happen
 * roughly ten times in ninety minutes and peak concurrency is dozens of
 * viewers, so a 5s interval against a cached-revalidated JSON endpoint costs
 * almost nothing. A websocket would mean taking on Pusher or Ably to solve a
 * problem this site does not have.
 */
(function () {
	'use strict';

	var POLL_MS      = 5000;
	var POLL_HIDDEN  = 30000;  // tab in the background: back right off
	var MAX_BACKOFF  = 20000;  // recovery speed matters more here than saved polls
	var REQ_TIMEOUT  = 8000;

	var state    = window.RH_LIVE_BOOTSTRAP || null;
	var timer    = null;
	var backoff  = POLL_MS;
	var failures = 0;
	var clockBase = null;  // { gameSec, at } for ticking between polls
	var lastUpdated = (state && state.updated) || null;
	// score.php tags each state with its updated stamp, so the server-rendered
	// state already has a known tag and the first poll can be a cheap 304.
	var etag = lastUpdated ? '"' + lastUpdated + '"' : null;

	var el = {
		board:    document.getElementById('live-board'),
		pill:     document.getElementById('live-pill'),
		period:   document.getElementById('live-period'),
		clock:    document.getElementById('live-clock'),
		rice:     document.getElementById('live-rice'),
		opp:      document.getElementById('live-opp'),
		oppName:  document.getElementById('live-opp-name'),
		oppLogo:  document.getElementById('live-opp-logo'),
		empty:    document.getElementById('live-empty'),
		stale:    document.getElementById('live-stale'),
		videoSec: document.getElementById('live-video-section'),
		video:    document.getElementById('live-video'),
		videoLink: document.getElementById('live-video-link'),
		score:    document.getElementById('live-score'),
		chartSec: document.getElementById('live-chart-section'),
		chart:    document.getElementById('live-chart'),
		tip:      document.getElementById('live-tip'),
		pp:       document.getElementById('live-pp'),
		pens:     document.getElementById('live-pens'),
		penRice:  document.getElementById('live-pen-rice'),
		penOpp:   document.getElementById('live-pen-opp'),
		penSec:   document.getElementById('live-pen-section'),
		penLog:   document.getElementById('live-pen-log')
	};

	function pad(n) { return (n < 10 ? '0' : '') + n; }

	/* Game seconds -> clock within the current period, counting down from
	 * the period length like a rink clock. Event times in the summaries use
	 * it too, so they read as the clock did when the goal went in. */
	function formatClock(gameSec, periodLength) {
		var into = gameSec % periodLength;
		if (gameSec > 0 && into === 0) { into = periodLength; }
		var left = periodLength - into;
		return pad(Math.floor(left / 60)) + ':' + pad(left % 60);
	}

	function periodLabel(p, total) {
		if (!p) { return ''; }
		if (p > total) { return 'Final'; }
		return 'Period ' + p;
	}

	/* ------------------------------------------------------------ render -- */

	function render() {
		// No game object at all. Showing "Rice 0 - Opponent 0" underneath the
		// message reads as a broken scoreboard rather than as nothing being on,
		// so the whole board is hidden. A game that exists but has not started
		// ('scheduled') still shows 0-0, which is correct.
		if (!state || state.status === 'none') {
			el.empty.hidden = false;
			el.score.hidden = true;
			el.pill.hidden = true;
			el.videoSec.hidden = true;
			el.chartSec.hidden = true;
			el.penSec.hidden = true;
			el.pens.hidden = true;
			el.pp.hidden = true;
			el.period.textContent = '';
			el.clock.textContent = '';
			tl = null;
			return;
		}
		el.empty.hidden = true;
		el.score.hidden = false;
		el.pill.hidden = false;

		el.pill.textContent = state.status;
		el.pill.className = 'live-pill' +
			(state.status === 'live' ? ' is-live' : '') +
			(state.status === 'final' ? ' is-final' : '');

		el.period.textContent = periodLabel(state.period, state.periods);
		el.rice.textContent = state.score.rice;
		el.opp.textContent  = state.score.opp;
		el.oppName.textContent = state.opponent;

		// The admin can set the opponent's colour. Everything on the page that
		// marks the opponent reads --live-opp, so this one property repaints
		// all of it; empty falls back to the stylesheet's default.
		if (state.opponent_color) {
			document.documentElement.style.setProperty('--live-opp', state.opponent_color);
		} else {
			document.documentElement.style.removeProperty('--live-opp');
		}

		if (state.opponent_logo) {
			el.oppLogo.src = state.opponent_logo;
			el.oppLogo.alt = state.opponent;
			el.oppLogo.hidden = false;
		} else {
			el.oppLogo.hidden = true;
		}

		tickClock();
		renderVideo();
		renderChart();
		renderLog();
		renderPenaltyLog();
	}

	/* The clock ticks locally between polls so it looks continuous; each poll
	 * re-anchors it to the server's value so it cannot drift. */
	function nowSec() {
		if (!state || state.status !== 'live' || !state.clock_running || !clockBase) {
			return (state && state.game_sec) || 0;
		}
		var elapsed = Math.floor((Date.now() - clockBase.at) / 1000);
		return Math.min(clockBase.gameSec + elapsed, state.period * state.period_length);
	}

	function tickClock() {
		// Stopped clock shown dimmed, as a rink clock reads during a stoppage.
		el.clock.classList.toggle('is-stopped', !!state && state.status === 'live' && !state.clock_running);
		if (state && state.status === 'live') {
			el.clock.textContent = formatClock(nowSec(), state.period_length);
		} else if (state && state.status !== 'final' && state.game_sec) {
			el.clock.textContent = formatClock(state.game_sec, state.period_length);
		} else {
			el.clock.textContent = '';
		}
		renderPenalties();
		updateTimelineNow();
	}

	/* ------------------------------------------------------- penalties -- */

	function mmss(sec) { return Math.floor(sec / 60) + ':' + pad(sec % 60); }

	function teamName(team) { return team === 'rice' ? 'Rice' : state.opponent; }

	function penaltyText(p) {
		// Non-breaking: "#8" never ends up on a line of its own.
		return (p.player ? '#' + escapeHtml(p.player) + '&nbsp;' : '') + escapeHtml(p.infraction);
	}

	/* Expiry changes nothing on the server, so the poll never reports it. The
	 * page works out what is still running from its own ticking clock, and the
	 * server only supplies when each penalty ends. */
	function renderPenalties() {
		var live = state && state.status === 'live';
		var now  = nowSec();
		var html = { rice: '', opp: '' };
		var off  = { rice: 0, opp: 0 };
		var any  = false;

		(live && state.penalties || []).forEach(function (p) {
			var left = p.end_sec - now;
			if (left <= 0) { return; }
			any = true;
			html[p.team] += '<li><span class="live-pen-left">' + mmss(left) + '</span>' +
				'<span class="live-pen-what">' + penaltyText(p) + '</span></li>';
			if (p.minutes !== 10) { off[p.team]++; } // a misconduct is replaced on the ice
		});

		el.penRice.innerHTML = html.rice;
		el.penOpp.innerHTML  = html.opp;
		el.pens.hidden = !any;

		// No more than two skaters can be in the box at once for strength.
		var r = 5 - Math.min(2, off.rice);
		var o = 5 - Math.min(2, off.opp);
		if (r === 5 && o === 5) {
			el.pp.hidden = true;
			return;
		}
		el.pp.hidden = false;
		el.pp.textContent = r === o
			? r + ' on ' + o
			: teamName(r > o ? 'rice' : 'opp') + ' power play · ' + Math.max(r, o) + ' on ' + Math.min(r, o);
	}

	function renderPenaltyLog() {
		var pens = state.penalties || [];
		el.penSec.hidden = !pens.length;
		if (!pens.length) {
			el.penLog.innerHTML = '';
			return;
		}
		var rows = '';
		pens.forEach(function (p) {
			var isRice = p.team === 'rice';
			rows += '<tr><td><span class="live-swatch live-swatch-' +
				(isRice ? 'rice' : 'opp') + '"></span>' + escapeHtml(teamName(p.team)) + '</td>' +
				'<td>' + penaltyText(p) + '</td>' +
				'<td>' + p.minutes + ' min</td>' +
				'<td>P' + p.period + '</td>' +
				'<td>' + formatClock(p.game_sec, state.period_length) + '</td></tr>';
		});
		el.penLog.innerHTML = '<caption>Penalty summary</caption>' +
			'<thead><tr><th>Team</th><th>Infraction</th><th>Length</th><th>Period</th><th>Clock</th></tr></thead>' +
			'<tbody>' + rows + '</tbody>';
	}

	function renderVideo() {
		if (!state.youtube) {
			el.videoSec.hidden = true;
			el.video.innerHTML = '';
			return;
		}
		el.videoSec.hidden = false;
		if (el.video.getAttribute('data-vid') === state.youtube) { return; }
		el.video.setAttribute('data-vid', state.youtube);
		// Fallback for streams with embedding switched off, and for phones
		// that would rather open the YouTube app.
		el.videoLink.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(state.youtube);
		var f = document.createElement('iframe');
		// nocookie host: no tracking cookie until the viewer actually plays it
		f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(state.youtube) +
		        '?rel=0&modestbranding=1';
		f.title = 'Rice Hockey Club live broadcast';
		f.allow = 'accelerometer; encrypted-media; picture-in-picture; fullscreen';
		f.setAttribute('allowfullscreen', '');
		f.setAttribute('loading', 'lazy');
		el.video.innerHTML = '';
		el.video.appendChild(f);
	}

	/* ---------------------------------------------------------- timeline -- */

	/* Goals on one track for the whole game, Rice above and the opponent
	 * below. This replaced a running-total line chart: with a handful of goals
	 * a game that was two mostly flat lines. Here each goal is a mark at the
	 * moment it went in, and the side of the track says whose it was, so
	 * identity never rests on colour alone. The scoring summary table under
	 * it is the text equivalent. Plain SVG, so no chart library to load. */

	var SVG_NS = 'http://www.w3.org/2000/svg';
	var TL = { h: 168, track: 82, lane: 34, stack: 18, r: 6, hit: 13 };
	var tl = null;  // { x, played, now } for the once-a-second update

	function svg(tag, attrs, parent) {
		var n = document.createElementNS(SVG_NS, tag);
		Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
		if (parent) { parent.appendChild(n); }
		return n;
	}

	function ordinal(p) { return p + (['th', 'st', 'nd', 'rd'][p] || 'th'); }

	function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

	function renderChart() {
		hideTip();
		if (!state.events.length && state.status !== 'final') {
			el.chartSec.hidden = true;
			tl = null;
			return;
		}
		el.chartSec.hidden = false;

		var W      = el.chart.clientWidth || 600;
		var narrow = W < 480;
		var gutter = narrow ? 70 : 104;
		var total  = state.periods * state.period_length;
		var span   = W - gutter - 12;
		var x      = function (sec) { return gutter + span * Math.min(sec, total) / total; };
		var y0     = TL.track;

		var root = svg('svg', {
			width: W, height: TL.h, viewBox: '0 0 ' + W + ' ' + TL.h, role: 'img',
			'aria-label': 'Goal timeline. Rice ' + state.score.rice + ', ' +
				state.opponent + ' ' + state.score.opp + '.'
		});

		// Periods: hairline dividers, and a label under each third.
		for (var p = 0; p < state.periods; p++) {
			var x0 = x(p * state.period_length);
			var x1 = x((p + 1) * state.period_length);
			if (p > 0) {
				svg('line', { x1: x0, x2: x0, y1: 12, y2: TL.h - 30, 'class': 'tl-grid' }, root);
			}
			svg('text', { x: (x0 + x1) / 2, y: TL.h - 8, 'class': 'tl-axis', 'text-anchor': 'middle' }, root)
				.textContent = ordinal(p + 1);
		}

		// The whole game as a track, with the part already played filled in.
		svg('line', { x1: x(0), x2: x(total), y1: y0, y2: y0, 'class': 'tl-track' }, root);
		var played = svg('line', { x1: x(0), x2: x(0), y1: y0, y2: y0, 'class': 'tl-played' }, root);
		var now    = svg('line', { x1: 0, x2: 0, y1: y0 - 9, y2: y0 + 9, 'class': 'tl-now' }, root);

		// Lane labels are the legend: a key dot and the name, in ink.
		lane(root, 'rice', 'Rice', y0 - TL.lane, narrow);
		lane(root, 'opp', state.opponent, y0 + TL.lane, narrow);

		// A goal within a dot's width of the previous one on the same side
		// steps outward instead of hiding behind it.
		var r = 0, o = 0;
		var lastX = { rice: -1e9, opp: -1e9 };
		var level = { rice: 0, opp: 0 };
		state.events.forEach(function (e) {
			var team = e.team === 'rice' ? 'rice' : 'opp';
			if (team === 'rice') { r++; } else { o++; }
			var gx  = x(e.game_sec);
			level[team] = (gx - lastX[team] < TL.r * 2 + 4) ? level[team] + 1 : 0;
			lastX[team] = gx;
			var dir = team === 'rice' ? -1 : 1;
			var gy  = y0 + dir * (TL.lane + level[team] * TL.stack);

			var g = svg('g', { 'class': 'tl-goal tl-' + team, tabindex: 0 }, root);
			svg('line', { x1: gx, x2: gx, y1: y0 + dir * 4, y2: gy, 'class': 'tl-stem' }, g);
			svg('circle', { cx: gx, cy: gy, r: TL.hit, 'class': 'tl-hit' }, g);
			svg('circle', { cx: gx, cy: gy, r: TL.r, 'class': 'tl-dot' }, g);

			var info = {
				score: r + ' – ' + o,
				what:  (team === 'rice' ? 'Rice' : state.opponent) + ' goal · ' +
					ordinal(e.period) + ' ' + formatClock(e.game_sec, state.period_length)
			};
			var show = function () { showTip(info, gx, gy, dir); };
			g.setAttribute('aria-label', info.what + ', score ' + info.score);
			g.addEventListener('pointerenter', function (ev) { if (ev.pointerType === 'mouse') { show(); } });
			g.addEventListener('pointerleave', function (ev) { if (ev.pointerType === 'mouse') { hideTip(); } });
			g.addEventListener('click', show);  // touch: tap a goal to read it
			g.addEventListener('focus', show);
			g.addEventListener('blur', hideTip);
		});

		el.chart.innerHTML = '';
		el.chart.appendChild(root);
		tl = { x: x, played: played, now: now };
		updateTimelineNow();
	}

	function lane(root, team, name, y, narrow) {
		svg('circle', { cx: 6, cy: y, r: 5, 'class': 'tl-key tl-' + team }, root);
		svg('text', { x: 18, y: y, 'class': 'tl-lane', 'dominant-baseline': 'central' }, root)
			.textContent = truncate(name, narrow ? 7 : 11);
	}

	/* Runs every second with the clock, so the "now" mark moves smoothly
	 * between polls rather than jumping every five seconds. */
	function updateTimelineNow() {
		if (!tl) { return; }
		var live = state.status === 'live';
		var nx = tl.x(live ? nowSec() : state.periods * state.period_length);
		tl.played.setAttribute('x2', nx);
		tl.now.setAttribute('x1', nx);
		tl.now.setAttribute('x2', nx);
		tl.now.style.display = live ? '' : 'none';
	}

	/* Value leads, the label follows. Text goes in with textContent: the
	 * opponent's name is admin-entered. */
	function showTip(info, gx, gy, dir) {
		el.tip.textContent = '';
		var b = document.createElement('strong');
		var s = document.createElement('span');
		b.textContent = info.score;
		s.textContent = info.what;
		el.tip.appendChild(b);
		el.tip.appendChild(s);
		el.tip.hidden = false;

		// Over the dot, pointing away from the track, kept inside the card.
		var tw   = el.tip.offsetWidth;
		var th   = el.tip.offsetHeight;
		var left = Math.max(0, Math.min(gx - tw / 2, el.chart.clientWidth - tw));
		el.tip.style.left = (el.chart.offsetLeft + left) + 'px';
		el.tip.style.top  = (el.chart.offsetTop + (dir < 0 ? gy - TL.hit - 6 - th : gy + TL.hit + 6)) + 'px';
	}

	function hideTip() { el.tip.hidden = true; }

	document.addEventListener('click', function (ev) {
		if (!ev.target.closest || !ev.target.closest('.tl-goal')) { hideTip(); }
	});

	// Redraw at the new width; the SVG is laid out in real pixels so text
	// stays the same size rather than scaling with the card.
	var lastW = 0, resizeTimer = null;
	window.addEventListener('resize', function () {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(function () {
			if (state && state.events && el.chart.clientWidth !== lastW) {
				lastW = el.chart.clientWidth;
				renderChart();
			}
		}, 150);
	});

	/* Table view -- required so identity is never colour-alone, and a goal log
	 * is what most people actually want to scan anyway. */
	function renderLog() {
		var existing = document.getElementById('live-log');
		if (!state.events.length) {
			if (existing) { existing.remove(); }
			return;
		}
		var rows = '';
		var r = 0, o = 0;
		state.events.forEach(function (e) {
			if (e.team === 'rice') { r++; } else { o++; }
			var isRice = e.team === 'rice';
			rows += '<tr><td><span class="live-swatch live-swatch-' +
				(isRice ? 'rice' : 'opp') + '"></span>' +
				(isRice ? 'Rice' : escapeHtml(state.opponent)) + '</td>' +
				'<td>Period ' + e.period + '</td>' +
				'<td>' + formatClock(e.game_sec, state.period_length) + '</td>' +
				'<td>' + r + ' &ndash; ' + o + '</td></tr>';
		});
		var html = '<caption>Scoring summary</caption>' +
			'<thead><tr><th>Team</th><th>Period</th><th>Clock</th><th>Score</th></tr></thead>' +
			'<tbody>' + rows + '</tbody>';
		if (!existing) {
			existing = document.createElement('table');
			existing.id = 'live-log';
			existing.className = 'live-log';
			// Inside the card, on its surface: on the bare page the dark-mode
			// ink would be white text on the site's white background.
			el.chart.parentNode.appendChild(existing);
		}
		existing.innerHTML = html;
	}

	function escapeHtml(s) {
		return String(s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	/* -------------------------------------------------------------- poll -- */

	function poll() {
		// A hung request must fail fast rather than stall the loop: without an
		// abort, neither handler runs and polling stops until the browser's own
		// timeout, which is minutes.
		var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
		var killer = ctl ? setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT) : null;

		// The conditional request is made by hand, with the browser cache
		// switched off. Left to the browser, a 304 came back to this code as a
		// 200 carrying the *cached* body -- whose game_sec is from the last
		// change -- and re-anchoring to it snapped the clock back every poll.
		var headers = { 'Accept': 'application/json' };
		if (etag) { headers['If-None-Match'] = etag; }

		fetch('/score.php', {
			headers: headers,
			cache: 'no-store',
			signal: ctl ? ctl.signal : undefined
		})
			.then(function (res) {
				if (res.status === 304) { return null; }
				etag = res.headers.get('ETag') || null;
				// 503 is the endpoint saying "no store attached" -- a real
				// answer, not a failed request. Treating it as a transport
				// error made a KV-less deployment show "connection lost"
				// instead of the empty state.
				if (res.status === 503) { return { status: 'none' }; }
				if (!res.ok) { throw new Error('http ' + res.status); }
				return res.json();
			})
			.then(function (data) {
				clearTimeout(killer);
				failures = 0;
				backoff = POLL_MS;
				el.stale.hidden = true;
				if (data && data.updated !== lastUpdated) {
					lastUpdated = data.updated;
					state = data;
					clockBase = { gameSec: data.game_sec, at: Date.now() };
					render();
				} else if (data && data.game_sec !== undefined) {
					// Unchanged but freshly served (a proxy dropped the ETag):
					// re-anchor the clock so it cannot drift. Safe only because
					// the body above can no longer come from the browser cache.
					clockBase = { gameSec: data.game_sec, at: Date.now() };
				}
				schedule();
			})
			.catch(function () {
				clearTimeout(killer);
				failures++;
				if (failures >= 3) { el.stale.hidden = false; }
				backoff = Math.min(backoff * 2, MAX_BACKOFF);
				schedule();
			});
	}

	function interval() {
		if (document.hidden) { return POLL_HIDDEN; }
		if (failures) { return backoff; }
		// A finished game does not change; stop hammering the endpoint.
		if (state && state.status === 'final') { return POLL_HIDDEN; }
		return POLL_MS;
	}

	function schedule() {
		clearTimeout(timer);
		timer = setTimeout(poll, interval());
	}

	document.addEventListener('visibilitychange', function () {
		if (!document.hidden) { clearTimeout(timer); poll(); }
	});

	// A phone that reconnects to rink wifi should refresh immediately rather
	// than sit out the remaining backoff.
	window.addEventListener('online', function () {
		failures = 0;
		backoff = POLL_MS;
		clearTimeout(timer);
		poll();
	});

	if (state && state.game_sec !== undefined) {
		clockBase = { gameSec: state.game_sec, at: Date.now() };
	}
	render();
	setInterval(tickClock, 1000);
	schedule();
})();
