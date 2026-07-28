const CPGL_BOOT_VERSION = '0.4.0-20260727.1';
const CPGL_DEBUG_ENDPOINT = '/api/plugins/chatpulse_group_logic_debug/log';
let cpglBootTokenPromise = null;

async function getCpglBootToken() {
    if (!cpglBootTokenPromise) {
        cpglBootTokenPromise = fetch('/csrf-token')
            .then(response => response.ok ? response.json() : null)
            .then(data => data?.token || '')
            .catch(() => '');
    }
    return cpglBootTokenPromise;
}

function getCpglBootViewport() {
    return {
        version: CPGL_BOOT_VERSION,
        location: String(location.href || ''),
        userAgent: String(navigator.userAgent || ''),
        visualViewport: window.visualViewport ? {
            width: Math.round(window.visualViewport.width || 0),
            height: Math.round(window.visualViewport.height || 0),
            offsetLeft: Math.round(window.visualViewport.offsetLeft || 0),
            offsetTop: Math.round(window.visualViewport.offsetTop || 0),
            scale: Number(window.visualViewport.scale || 1),
        } : null,
        layoutViewport: {
            width: Math.round(window.innerWidth || 0),
            height: Math.round(window.innerHeight || 0),
        },
    };
}

async function reportCpglBoot(event, details = {}) {
    const payload = {
        index: 0,
        event,
        at: new Date().toISOString(),
        details,
        viewport: getCpglBootViewport(),
    };
    console.log('[ChatPulseGroupLogic BOOT]', payload);
    try {
        const token = await getCpglBootToken();
        fetch(CPGL_DEBUG_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify(payload),
        }).catch(error => console.warn('[ChatPulseGroupLogic BOOT] Debug endpoint unavailable:', error));
    } catch (error) {
        console.warn('[ChatPulseGroupLogic BOOT] Failed to report boot event:', error);
    }
}

reportCpglBoot('bootstrap.loaded');

import('./index.js?v=0.4.0-20260727.1')
    .then(() => reportCpglBoot('bootstrap.import.done'))
    .catch(error => {
        reportCpglBoot('bootstrap.import.error', {
            error: error?.message || String(error),
            stack: String(error?.stack || '').slice(0, 1200),
        });
        console.error('[ChatPulseGroupLogic BOOT] Failed to import index.js:', error);
    });
