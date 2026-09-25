<?php
/*
 * Polling endpoint. Returns the public game state as JSON.
 *
 * Deliberately cheap: one KV read, a few hundred bytes out. At a five second
 * interval and a few dozen concurrent viewers this is a handful of requests a
 * second, which is why this is polling and not a websocket dependency.
 */

require_once __DIR__ . '/../lib/module/sys-live.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache, must-revalidate');
header('Access-Control-Allow-Origin: *');

if (!kv_available()) {
    http_response_code(503);
    echo json_encode(['error' => 'store_unconfigured']);
    exit;
}

$state = live_load();

/*
 * An unreachable store is an error, not an empty schedule. Answering "no game"
 * here would tell everyone watching a live game that it had ended.
 */
if ($state === null && kv_failed()) {
    http_response_code(502);
    echo json_encode(['error' => 'store_unreachable']);
    exit;
}

if ($state === null) {
    // No game has been set up yet. Not an error — the live page renders an
    // idle state from this.
    echo json_encode(['status' => 'none']);
    exit;
}

$public = live_public($state);

/*
 * ETag on the state's updated stamp lets a polling client get a 304 with an
 * empty body when nothing has changed, which is the common case by far —
 * scoring happens maybe ten times in ninety minutes.
 */
$etag = '"' . $public['updated'] . '"';
header('ETag: ' . $etag);
if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
    http_response_code(304);
    exit;
}

echo json_encode($public, JSON_UNESCAPED_SLASHES);
