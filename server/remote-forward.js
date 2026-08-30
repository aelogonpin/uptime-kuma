const axios = require("axios");
const { UP, log } = require("../src/util");
const { Settings } = require("./settings");

const FLUSH_INTERVAL_MS = 10 * 1000;
const MAX_QUEUE_LENGTH = 500;
const PUSH_AGENT_PATH = "/api/push-agent";

let queue = [];
let flushTimer = null;
let flushInFlight = false;

/**
 * Queue a heartbeat to be forwarded to the configured central Uptime Kuma
 * instance. No-op if forwarding is disabled or the monitor is filtered out
 * by the configured tag. Safe to call for every heartbeat produced by this
 * instance (local checks and its own push monitors alike).
 * @param {Bean} monitor The monitor the heartbeat belongs to
 * @param {Bean} bean The heartbeat bean, already assigned a status
 * @returns {Promise<void>}
 */
async function enqueue(monitor, bean) {
    try {
        if (!(await Settings.get("remoteForwardEnabled"))) {
            return;
        }

        const tagFilter = await Settings.get("remoteForwardTagFilter");
        if (tagFilter) {
            const tags = await monitor.getTags();
            if (!tags.some((tag) => tag.name === tagFilter)) {
                return;
            }
        }

        queue.push({
            key: String(monitor.id),
            name: monitor.name,
            status: bean.status === UP ? "up" : "down",
            msg: bean.msg || "",
            ping: bean.ping,
            time: bean.time,
            // Config the central instance should mirror and keep in sync --
            // the agent is authoritative for these, central re-applies them
            // on every push so manual edits on the central side don't stick.
            interval: monitor.interval,
            retryInterval: monitor.retryInterval,
            resendInterval: monitor.resendInterval,
            maxretries: monitor.maxretries,
        });

        if (queue.length > MAX_QUEUE_LENGTH) {
            queue.splice(0, queue.length - MAX_QUEUE_LENGTH);
        }
    } catch (e) {
        log.warn("remote-forward", `Failed to enqueue heartbeat for monitor #${monitor.id}: ${e.message}`);
    }
}

/**
 * Send any queued heartbeats to the central instance. Queued items are put
 * back on failure so they are retried on the next flush.
 * @returns {Promise<void>}
 */
async function flush() {
    if (queue.length === 0 || flushInFlight) {
        return;
    }

    const enabled = await Settings.get("remoteForwardEnabled");
    const centralUrl = await Settings.get("remoteForwardCentralUrl");
    const apiKey = await Settings.get("remoteForwardApiKey");
    const agentName = await Settings.get("remoteForwardAgentName");

    if (!enabled || !centralUrl || !apiKey || !agentName) {
        return;
    }

    flushInFlight = true;
    const batch = queue.splice(0, queue.length);

    try {
        await axios.post(
            `${String(centralUrl).replace(/\/+$/, "")}${PUSH_AGENT_PATH}`,
            {
                agentName,
                monitors: batch,
            },
            {
                auth: {
                    username: "remote-agent",
                    password: apiKey,
                },
                timeout: 10000,
            }
        );
    } catch (e) {
        log.warn("remote-forward", `Failed to forward ${batch.length} heartbeat(s) to central instance: ${e.message}`);
        queue.unshift(...batch);
        if (queue.length > MAX_QUEUE_LENGTH) {
            queue.splice(0, queue.length - MAX_QUEUE_LENGTH);
        }
    } finally {
        flushInFlight = false;
    }
}

/**
 * Start the periodic flush loop. Safe to call multiple times.
 * @returns {void}
 */
function start() {
    if (flushTimer) {
        return;
    }
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

/**
 * Stop the periodic flush loop, mainly for tests.
 * @returns {void}
 */
function stop() {
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
}

module.exports = {
    enqueue,
    flush,
    start,
    stop,
};
