<?php
/*
 * Public live game page. Renders the current state server-side so the first
 * paint is correct with no JavaScript, then polls /score.php to keep it fresh.
 */

require_once __DIR__ . '/../lib/module/sys-live.php';

$state    = kv_available() ? live_load() : null;
$public   = $state ? live_public($state) : null;
/*
 * Embedded in an inline <script>, so a literal "</script>" inside any string
 * value would close the element and inject markup. JSON_HEX_TAG escapes < and >
 * to \u003C / \u003E, which JSON.parse and the JS engine both read back
 * identically. Do NOT add JSON_UNESCAPED_SLASHES here.
 */
$bootstrap = $public
    ? json_encode($public, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT)
    : 'null';

function h($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
?>
<!doctype html>
<html lang="en-US">
<head>
<title>Rice Hockey Club - Watch Live</title>
<meta charset="utf-8">
<meta name="description" content="Live score and broadcast for Rice Hockey Club games">
<?php include __DIR__ . '/../lib/module/sys-meta.php';?>
<meta property="og:title" content="Rice Hockey Club - Live" />
<meta property="og:description" content="Live score and broadcast for Rice Hockey Club games" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:url" content="" />
<meta property="og:locale" content="en_EN"/>
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Rice Hockey Club" />

<?php include __DIR__ . '/../lib/module/sys-css.php';?>
<link rel="stylesheet" type="text/css" href="<?= asset_v('/lib/css/live.css') ?>"/>
<?php include __DIR__ . '/../lib/module/sys-js.php';?>
</head>
<body class="live-page">
<?php include __DIR__ . '/../lib/module/sys-php.php';?>
<div class="page-con-content">
	<div class="banner-con-container darkmode-header">
		<div id="object-particles">
		</div>
		<div class="wavebar-con-container">
			<div class="wavebar-con-wrap">
				<div class="wavebar-svg-object">
				</div>
				<div class="wavebar-svg-object">
				</div>
			</div>
		</div>
		<div class='banner-con-title fade-up-onstart'>
			<div class='banner-tx1-title fade-up-onstart'>
				<h1>Watch Live</h1>
			</div>
			<div class='banner-con-divider'>
			</div>
		</div>
	</div>

	<div class="page-con-container">
		<div class="page-in-container">

			<!-- Scoreboard ------------------------------------------------ -->
			<div class="live-board" id="live-board">
				<div class="live-state">
					<span class="live-pill" id="live-pill">&nbsp;</span>
					<span class="live-period" id="live-period"></span>
					<span class="live-clock" id="live-clock"></span>
				</div>
				<div class="live-score" id="live-score">
					<div class="live-side">
						<img class="live-logo" src="/img/uni_logos/rice_logo.webp" alt="Rice">
						<span class="live-name">Rice</span>
						<span class="live-num" id="live-rice">0</span>
					</div>
					<span class="live-dash">&ndash;</span>
					<div class="live-side">
						<img class="live-logo" id="live-opp-logo" src="" alt="" hidden>
						<span class="live-name" id="live-opp-name">Opponent</span>
						<span class="live-num" id="live-opp">0</span>
					</div>
				</div>
				<div class="live-none" id="live-empty" hidden>
					<p class="live-none-title">No game is on right now</p>
					<p class="live-none-sub">Broadcasts go live on game day. Check the <a href="/tickets.php">schedule</a> for upcoming games.</p>
				</div>
				<p class="live-stale" id="live-stale" hidden>Connection lost &mdash; retrying.</p>
			</div>

			<!-- Broadcast ------------------------------------------------- -->
			<div class="live-section" id="live-video-section" hidden>
				<div class='splitter-con-container'>
					<div class='splitter-txt-wrapper'>
						<div class='container-con-block darkmode-block'>
							<div class='container-con-wrapper'>
								<div class='container-tx1-block darkmode-txt'>
									<div class='container-emp-block'></div>
									<h2>Broadcast</h2>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div class="live-video" id="live-video"></div>
			</div>

			<!-- Scoring chart --------------------------------------------- -->
			<div class="live-section" id="live-chart-section" hidden>
				<div class='splitter-con-container'>
					<div class='splitter-txt-wrapper'>
						<div class='container-con-block darkmode-block'>
							<div class='container-con-wrapper'>
								<div class='container-tx1-block darkmode-txt'>
									<div class='container-emp-block'></div>
									<h2>Scoring</h2>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div class="live-chart-wrap">
					<canvas id="live-chart" height="260" aria-label="Running score by game clock"></canvas>
				</div>
			</div>

		</div>
	</div>
<?php include __DIR__ . '/../lib/module/inc-attribution.php';?>
</div>

<script>window.RH_LIVE_BOOTSTRAP = <?= $bootstrap ?>;</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="<?= asset_v('/lib/js/live.js') ?>"></script>
</body>
</html>
