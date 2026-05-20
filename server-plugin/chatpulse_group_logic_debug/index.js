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
}

module.exports = {
    init,
    info: {
        id: 'chatpulse_group_logic_debug',
        name: 'ChatPulse Group Logic Debug',
        description: 'Prints ChatPulse Group Logic frontend click and viewport probes to the SillyTavern server console.',
    },
};
