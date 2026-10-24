<?php
/*
 * Broadcast overlay for OBS / Streamlabs.
 *
 * Added as a Browser Source above the camera, so the score becomes part of the
 * video itself: it shows on YouTube, in full screen and in the replay, not
 * only on this site. Everything but the score bug is transparent. Laid out
 * for a 1920x1080 source.
 */

require_once __DIR__ . '/../lib/module/sys-live.php';
require_once __DIR__ . '/../lib/module/sys-asset.php';

header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

$state = kv_available() ? live_load() : null;
// Same escaping as live.php: this lands inside an inline <script>.
$bootstrap = $state
    ? json_encode(live_public($state), JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT)
    : 'null';
?>
<!doctype html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<title>Stream Overlay - Rice Hockey Club</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="<?= asset_v('/lib/css/overlay.css') ?>"/>
</head>
<body>

<div class="ov" id="ov" hidden>
	<div class="ov-bar">
		<div class="ov-team ov-rice">
			<img class="ov-logo" src="/img/uni_logos/rice_logo.webp" alt="">
			<span class="ov-name">Rice</span>
			<span class="ov-num" id="ov-rice">0</span>
		</div>
		<div class="ov-team ov-opp">
			<img class="ov-logo" id="ov-opp-logo" src="" alt="" hidden>
			<span class="ov-name" id="ov-opp-name">Opponent</span>
			<span class="ov-num" id="ov-opp">0</span>
		</div>
		<div class="ov-time">
			<span class="ov-period" id="ov-period"></span>
			<span class="ov-clock" id="ov-clock"></span>
		</div>
	</div>
	<div class="ov-strip" id="ov-strip" hidden>
		<span id="ov-strip-text"></span>
		<span class="ov-strip-clock" id="ov-strip-clock"></span>
	</div>
	<div class="ov-goal" id="ov-goal" hidden></div>
</div>

<script>window.RH_LIVE_BOOTSTRAP = <?= $bootstrap ?>;</script>
<script src="<?= asset_v('/lib/js/overlay.js') ?>"></script>
</body>
</html>
