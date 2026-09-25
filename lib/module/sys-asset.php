<?php
/*
 * Cache-busting token for static assets.
 *
 * vercel.json serves /img and /lib with `max-age=31536000, immutable`, which is
 * only safe when the URL changes whenever the file does. Assets used to be
 * referenced as `main.css?v1` -- a constant -- so a browser that loaded the
 * site once kept that stylesheet for a year and never saw a deploy again.
 * `immutable` makes it worse by suppressing revalidation on reload.
 *
 * The token below changes on every deploy, so each deploy publishes new URLs
 * and the long cache becomes correct rather than harmful.
 */

if (!function_exists('asset_v')) {

    function asset_version()
    {
        static $v = null;
        if ($v !== null) {
            return $v;
        }

        // Vercel exposes the deploy's commit; short form is plenty.
        $sha = getenv('VERCEL_GIT_COMMIT_SHA')
            ?: ($_ENV['VERCEL_GIT_COMMIT_SHA'] ?? '')
            ?: ($_SERVER['VERCEL_GIT_COMMIT_SHA'] ?? '');
        if ($sha !== '' && $sha !== false) {
            return $v = substr($sha, 0, 8);
        }

        // Local dev, or a deploy without git metadata: fall back to the mtime
        // of a file that changes whenever the front end does.
        $probe = __DIR__ . '/../css/main.css';
        if (is_readable($probe)) {
            $m = @filemtime($probe);
            if ($m) {
                return $v = (string) $m;
            }
        }

        return $v = 'dev';
    }

    /* Append the token to an asset path: asset_v('/lib/css/main.css') */
    function asset_v($path)
    {
        return $path . '?v=' . asset_version();
    }
}
