/**
 * ChatPulse Group Logic debug server plugin.
 *
 * Copy this folder to SillyTavern/plugins/chatpulse_group_logic_debug
 * and restart SillyTavern to see frontend tap/layout probes in the server TUI.
 */

const recentLogs = [];

function trimText(value, max = 240) {
    const text = String(value ?? '');
    return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function formatRect(rect) {
    if (!rect) return 'none';
    return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

function printDebugLog(payload) {
    const viewport = payload?.viewport || {};
    const details = payload?.details || {};
    const vv = viewport.visualViewport
        ? `${viewport.visualViewport.width}x${viewport.visualViewport.height}@${viewport.visualViewport.scale} +${viewport.visualViewport.offsetLeft},${viewport.visualViewport.offsetTop}`
        : 'none';
    const layout = viewport.layoutViewport
        ? `${viewport.layoutViewport.width}x${viewport.layoutViewport.height}`
        : 'none';
    console.log([
        `[CPGL DEBUG #${payload?.index ?? '?'}]`,
        payload?.event || 'unknown',
        trimText(details.element || ''),
        `version=${viewport.version || ''}`,
        `touch=${viewport.touch ? '1' : '0'}`,
        `vv=${vv}`,
        `layout=${layout}`,
        `modal=${formatRect(viewport.modal?.rect)}`,
        `shell=${formatRect(viewport.shell?.rect)}`,
        viewport.modal?.dataset ? `data="${trimText(viewport.modal.dataset, 180)}"` : '',
        details.error ? `error="${trimText(details.error)}"` : '',
    ].filter(Boolean).join(' | '));
}

async function init(router) {
    console.log('[CPGL DEBUG] Server debug plugin initialized. POST /api/plugins/chatpulse_group_logic_debug/log');

    router.post('/log', (req, res) => {
        const payload = req.body || {};
        recentLogs.push({ ...payload, receivedAt: Date.now() });
        if (recentLogs.length > 80) recentLogs.splice(0, recentLogs.length - 80);
        printDebugLog(payload);
        res.json({ success: true });
    });

    router.get('/recent', (_req, res) => {
        res.json({ logs: recentLogs });
    });

    router.get('/diagnose', (_req, res) => {
        res.type('html').send(`<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CPGL Diagnose</title>
    <style>
        body { font-family: system-ui, sans-serif; padding: 16px; line-height: 1.5; }
        pre { white-space: pre-wrap; word-break: break-word; background: #111; color: #9f9; padding: 12px; border-radius: 8px; }
        button { padding: 10px 14px; margin: 4px 0; }
    </style>
</head>
<body>
    <h3>ChatPulse Group Logic Diagnose</h3>
    <button id="run">运行诊断</button>
    <pre id="out">等待运行...</pre>
    <script type="module">
        const out = document.getElementById('out');
        const write = (line) => { out.textContent += line + '\\n'; };
        const reset = () => { out.textContent = ''; };
        async function getToken() {
            const response = await fetch('/csrf-token');
            const data = await response.json();
            return data.token || '';
        }
        async function postDebug(event, details = {}) {
            const token = await getToken();
            const response = await fetch('/api/plugins/chatpulse_group_logic_debug/log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                body: JSON.stringify({
                    index: 0,
                    event,
                    at: new Date().toISOString(),
                    details,
                    viewport: {
                        version: 'diagnose',
                        location: location.href,
                        layoutViewport: { width: innerWidth, height: innerHeight },
                    },
                }),
            });
            write('POST debug: ' + response.status);
        }
        async function checkText(url) {
            const response = await fetch(url, { cache: 'no-store' });
            const text = await response.text();
            write(url + ' -> ' + response.status + ' ' + response.statusText + ' len=' + text.length);
            write(text.slice(0, 220).replace(/\\n/g, ' '));
            return { response, text };
        }
        async function run() {
            reset();
            try {
                await postDebug('diagnose.page.loaded', { userAgent: navigator.userAgent });
                await checkText('/api/extensions/discover');
                await checkText('/scripts/extensions/third-party/ChatPulseGroupLogic/manifest.json');
                await checkText('/scripts/extensions/third-party/ChatPulseGroupLogic/bootstrap.js');
                write('import bootstrap.js ...');
                await import('/scripts/extensions/third-party/ChatPulseGroupLogic/bootstrap.js?diagnose=' + Date.now());
                write('import bootstrap.js done');
            } catch (error) {
                write('ERROR: ' + (error?.stack || error?.message || String(error)));
                try { await postDebug('diagnose.page.error', { error: error?.message || String(error) }); } catch {}
            }
        }
        document.getElementById('run').addEventListener('click', run);
        run();
    </script>
</body>
</html>`);
    });
}

module.exports = {
    init,
    info: {
        id: 'chatpulse_group_logic_debug',
        name: 'ChatPulse Group Logic Debug',
        description: 'Prints ChatPulse Group Logic frontend click and viewport probes to the SillyTavern server console.',
    },
};
