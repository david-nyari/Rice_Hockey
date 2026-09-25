<?php require_once __DIR__ . '/sys-asset.php'; ?>
<script data-cfasync="false" src='<?= asset_v('/lib/js/jquery.js') ?>'></script>
<script data-cfasync="false" src='<?= asset_v('/lib/js/main.js') ?>'></script>
<script data-cfasync="false" src='<?= asset_v('/lib/js/jscookie.js') ?>'></script>
<script data-cfasync="false" src='<?= asset_v('/lib/js/particles.js') ?>'></script>
<script data-cfasync="false" src='<?= asset_v('/lib/js/particles-sel.js') ?>'></script>
<noscript>
<style>
/*
General:
- Elements that fade in are not visible by default
*/
.fade-up-onstart {
	display:inherit;
}
.fade-in-onload {
	display:inherit;
}
/*
Index:
- Center index contents
*/
.landing-con-container {
	top:50%;
	margin-top:-139px;
}
/*
Quickstart:
- Remove dimming
- Do not block interaction outside the sidebar
- Slightly reduce the width of the sidebar
*/
.toggle-navsidebar {
	background:none;
	width:auto;
}
.sidebar-con-anim {
	width:300px;
}
</style>
</noscript>
<script defer src="/_vercel/insights/script.js"></script>
