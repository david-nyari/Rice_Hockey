/*
 * Public live page: poll, render, chart.
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
	var chart    = null;
	var timer    = null;
	var backoff  = POLL_MS;
	var failures = 0;
	var clockBase = null;  // { gameSec, at } for ticking between polls
	var lastUpdated = (state && state.updated) || null;

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
		score:    document.getElementById('live-score'),
		chartSec: document.getElementById('live-chart-section'),
		canvas:   document.getElementById('live-chart')
	};

	function cssVar(name, fallback) {
		var v = getComputedStyle(document.documentElement).getPropertyValue(name);
		return (v && v.trim()) || fallback;
	}

	function pad(n) { return (n < 10 ? '0' : '') + n; }

	/* Game seconds -> clock within the current period, counting up. */
	function formatClock(gameSec, periodLength) {
		var into = gameSec % periodLength;
		if (gameSec > 0 && into === 0) { into = periodLength; }
		return pad(Math.floor(into / 60)) + ':' + pad(into % 60);
	}

	/* A tick at an exact period boundary belongs to the period that just ended
	   (1200s is "P1 20:00", not "P2 00:00"). */
	function clockTick(v, periodLength) {
		var p = Math.floor(v / periodLength) + 1;
		var into = v % periodLength;
		if (into === 0 && v > 0) { p = v / periodLength; into = periodLength; }
		return 'P' + p + ' ' + pad(Math.floor(into / 60)) + ':' + pad(into % 60);
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
			el.period.textContent = '';
			el.clock.textContent = '';
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
	}

	/* The clock ticks locally between polls so it looks continuous; each poll
	 * re-anchors it to the server's value so it cannot drift. */
	function tickClock() {
		if (!state || state.status !== 'live' || !clockBase) {
			if (state && state.status === 'final') {
				el.clock.textContent = '';
			} else if (state && state.game_sec) {
				el.clock.textContent = formatClock(state.game_sec, state.period_length);
			} else {
				el.clock.textContent = '';
			}
			return;
		}
		var elapsed = Math.floor((Date.now() - clockBase.at) / 1000);
		var sec = Math.min(clockBase.gameSec + elapsed, state.period * state.period_length);
		el.clock.textContent = formatClock(sec, state.period_length);
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

	/* ------------------------------------------------------------- chart -- */

	/* Cumulative score as {x: gameSeconds, y: goals}. A goal is a step, not a
	 * ramp, so the line is stepped -- an interpolated diagonal would imply the
	 * score passed through values it never held. */
	function series(team) {
		var pts = [{ x: 0, y: 0 }];
		var total = 0;
		state.events.forEach(function (e) {
			if (e.team !== team) { return; }
			total++;
			pts.push({ x: e.game_sec, y: total });
		});
		var end = state.status === 'final'
			? state.periods * state.period_length
			: Math.max(state.game_sec, 0);
		if (end > pts[pts.length - 1].x) { pts.push({ x: end, y: total }); }
		return pts;
	}

	/* Direct end-labels: with two series the legend carries identity, and a
	 * label at the end of each line means the reader never has to trace a
	 * colour back to a key. */
	var endLabelPlugin = {
		id: 'rhEndLabels',
		afterDatasetsDraw: function (c) {
			var ctx = c.ctx;
			ctx.save();
			ctx.font = '600 12px system-ui, sans-serif';
			ctx.textBaseline = 'middle';
			c.data.datasets.forEach(function (ds, i) {
				var meta = c.getDatasetMeta(i);
				if (!meta.data || !meta.data.length) { return; }
				var last = meta.data[meta.data.length - 1];
				ctx.fillStyle = ds.borderColor;
				ctx.textAlign = 'left';
				var name = ds.label.length > 11 ? ds.label.slice(0, 10) + '\u2026' : ds.label;
				var text = name + ' ' + ds.data[ds.data.length - 1].y;
				var x = Math.min(last.x + 8, c.width - ctx.measureText(text).width - 4);
				ctx.fillText(text, x, last.y);
			});
			ctx.restore();
		}
	};

	function renderChart() {
		if (!state.events.length && state.status !== 'final') {
			el.chartSec.hidden = true;
			return;
		}
		el.chartSec.hidden = false;
		if (typeof Chart === 'undefined') { return; }

		var rice = series('rice');
		var opp  = series('opp');
		var maxX = state.status === 'final'
			? state.periods * state.period_length
			: Math.max(state.game_sec, 60);

		if (chart) {
			chart.data.datasets[0].data = rice;
			chart.data.datasets[1].data = opp;
			chart.data.datasets[1].label = state.opponent;
			chart.options.scales.x.max = maxX;
			chart.update('none');
			return;
		}

		var ink     = cssVar('--live-ink-2', '#52514e');
		var grid    = cssVar('--live-grid', 'rgba(0,0,0,.08)');
		var cRice   = cssVar('--live-rice', '#2a78d6');
		var cOpp    = cssVar('--live-opp', '#eb6834');
		var pLength = state.period_length;

		chart = new Chart(el.canvas.getContext('2d'), {
			type: 'line',
			data: {
				datasets: [
					{ label: 'Rice', data: rice, borderColor: cRice, backgroundColor: cRice },
					{ label: state.opponent, data: opp, borderColor: cOpp, backgroundColor: cOpp }
				]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				parsing: false,
				layout: { padding: { right: 96, top: 8 } },
				elements: {
					line:  { stepped: 'after', borderWidth: 2, tension: 0 },
					point: { radius: 5, hoverRadius: 7, borderWidth: 2, borderColor: cssVar('--live-surface', '#fff') }
				},
				interaction: { mode: 'index', intersect: false },
				scales: {
					x: {
						type: 'linear',
						min: 0,
						max: maxX,
						title: { display: true, text: 'Game clock', color: ink, font: { size: 12 } },
						grid: { color: grid, drawTicks: false },
						border: { display: false },
						// Ticks are placed explicitly on half-period boundaries.
						// Left to itself Chart.js derives them from the axis max,
						// which lands them on fractional seconds.
						afterBuildTicks: function (axis) {
							var step = pLength / 2, out = [];
							for (var v = 0; v <= axis.max + 1; v += step) { out.push({ value: v }); }
							axis.ticks = out;
						},
						ticks: {
							color: ink,
							font: { size: 11 },
							autoSkip: false,
							callback: function (v) { return clockTick(Math.round(v), pLength); }
						}
					},
					y: {
						beginAtZero: true,
						title: { display: true, text: 'Goals', color: ink, font: { size: 12 } },
						grid: { color: grid, drawTicks: false },
						border: { display: false },
						ticks: { color: ink, font: { size: 11 }, precision: 0, stepSize: 1 }
					}
				},
				plugins: {
					legend: {
						display: true,
						position: 'top',
						align: 'start',
						labels: { color: ink, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rect' }
					},
					tooltip: {
						callbacks: {
							title: function (items) {
								return clockTick(Math.round(items[0].parsed.x), pLength);
							},
							label: function (item) {
								return item.dataset.label + ': ' + item.parsed.y;
							}
						}
					}
				}
			},
			plugins: [endLabelPlugin]
		});
	}

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
			el.chartSec.appendChild(existing);
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

		fetch('/score.php', {
			headers: { 'Accept': 'application/json' },
			signal: ctl ? ctl.signal : undefined
		})
			.then(function (res) {
				if (res.status === 304) { return null; }
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
					// Unchanged, but re-anchor the clock so it cannot drift.
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
