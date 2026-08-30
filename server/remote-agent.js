const { R } = require("redbean-node");
const dayjs = require("dayjs");
const crypto = require("crypto");
const { UP, DOWN, MAINTENANCE, genSecret, log } = require("../src/util");
const Monitor = require("./model/monitor");
const { UptimeCalculator } = require("./uptime-calculator");
const { UptimeKumaServer } = require("./uptime-kuma-server");

const MAX_MONITORS_PER_BATCH = 200;
const DEFAULT_CHILD_INTERVAL = 60;
const DEFAULT_GROUP_INTERVAL = 30;

/**
 * Ingest a batch of monitor statuses pushed by a remote agent (e.g. a
 * satellite Uptime Kuma instance in a restricted network zone). Each item
 * is mapped to (or auto-creates) a "push" type monitor grouped under a
 * dashboard group named after the agent, reusing the same heartbeat/status
 * logic as the regular /api/push/:pushToken route.
 * @param {number} userID Owner user id, resolved from the credentials used to authenticate the request
 * @param {string} agentName Name of the remote agent; used as the dashboard group name
 * @param {Array<object>} monitorItems Array of { key, name, status, msg, ping, time }
 * @returns {Promise<void>}
 */
async function ingestAgentBatch(userID, agentName, monitorItems) {
    const name = typeof agentName === "string" ? agentName.trim() : "";
    if (!name) {
        throw new Error("agentName is required");
    }

    if (!Array.isArray(monitorItems) || monitorItems.length === 0) {
        throw new Error("monitors must be a non-empty array");
    }

    if (monitorItems.length > MAX_MONITORS_PER_BATCH) {
        throw new Error(`Too many monitors in one batch (max ${MAX_MONITORS_PER_BATCH})`);
    }

    const group = await findOrCreateGroup(userID, name);

    for (const item of monitorItems) {
        if (!item || typeof item.name !== "string" || !item.name.trim()) {
            log.warn("remote-agent", `Skipping malformed item from agent "${name}"`);
            continue;
        }
        await ingestOne(userID, group.id, item);
    }
}

/**
 * Find or create the dashboard group monitor representing a remote agent.
 * @param {number} userID Owner user id
 * @param {string} name Agent name, used as the group name
 * @returns {Promise<Bean>} The group monitor bean
 */
async function findOrCreateGroup(userID, name) {
    let group = await R.findOne("monitor", " user_id = ? AND type = 'group' AND name = ? ", [userID, name]);

    if (group) {
        return group;
    }

    group = R.dispense("monitor");
    group.user_id = userID;
    group.name = name;
    group.type = "group";
    group.parent = null;
    group.interval = DEFAULT_GROUP_INTERVAL;
    group.retryInterval = DEFAULT_GROUP_INTERVAL;
    group.resendInterval = 0;
    group.maxretries = 0;
    group.accepted_statuscodes_json = JSON.stringify(["200-299"]);
    group.active = 1;
    group.validate();

    await R.store(group);
    await startAutoCreatedMonitor(group);

    log.info("remote-agent", `Created group monitor #${group.id} for agent "${name}" (user ${userID})`);

    return group;
}

/**
 * Derive a stable, deterministic identifier for a satellite monitor within
 * a given group, reusing the existing `push_token` column instead of adding
 * a new one. This lets renames on the satellite update the matching central
 * monitor in place instead of creating a duplicate.
 * @param {number} groupID Id of the parent group monitor
 * @param {string} itemKey Stable key sent by the agent (its local monitor id)
 * @returns {string} A 32-char token to store in push_token
 */
function deriveStableToken(groupID, itemKey) {
    return crypto
        .createHash("sha256")
        .update(`${groupID}:${itemKey}`)
        .digest("hex")
        .slice(0, 32);
}

const MANAGED_DESCRIPTION =
    "Managed by a remote agent. Interval/retry/resend settings are synced from the agent on every push and will be overwritten -- change them on the agent instead.";

/**
 * Coerce a config value sent by the agent into a safe non-negative integer,
 * falling back to a default if missing/invalid.
 * @param {*} value Raw value from the agent payload
 * @param {number} fallback Value to use if invalid
 * @param {number} min Minimum accepted value
 * @returns {number} Sanitized integer
 */
function sanitizeConfigValue(value, fallback, min = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * Find or create the child "push" monitor for a single item of a remote
 * agent's batch, then store a heartbeat for it. The agent is authoritative
 * for interval/retryInterval/resendInterval/maxretries: they're re-applied
 * from every push, overwriting any manual edit made on the central side.
 * @param {number} userID Owner user id
 * @param {number} groupID Id of the parent group monitor
 * @param {object} item One entry from the agent's batch payload
 * @returns {Promise<void>}
 */
async function ingestOne(userID, groupID, item) {
    const name = item.name.trim();
    const statusFromParam = item.status === "down" ? DOWN : UP;
    const ping = Number.isFinite(item.ping) ? item.ping : parseFloat(item.ping) || null;
    const msg = typeof item.msg === "string" ? item.msg : "";
    const stableToken = item.key ? deriveStableToken(groupID, item.key) : null;

    const desiredInterval = sanitizeConfigValue(item.interval, DEFAULT_CHILD_INTERVAL, 1);
    const desiredRetryInterval = sanitizeConfigValue(item.retryInterval, DEFAULT_CHILD_INTERVAL, 1);
    const desiredResendInterval = sanitizeConfigValue(item.resendInterval, 0, 0);
    const desiredMaxretries = sanitizeConfigValue(item.maxretries, 0, 0);

    // Match by the stable per-satellite-monitor key first, so a rename on
    // the agent updates this monitor instead of creating a new one. Fall
    // back to matching by name only to adopt monitors created before this
    // key existed (or if the agent didn't send one) -- once adopted, their
    // push_token is rewritten to the stable key for future pushes.
    let monitor = null;
    if (stableToken) {
        monitor = await R.findOne("monitor", " parent = ? AND push_token = ? ", [groupID, stableToken]);
    }
    if (!monitor) {
        monitor = await R.findOne("monitor", " parent = ? AND name = ? ", [groupID, name]);
    }

    let isNewMonitor = false;
    let configChanged = false;

    if (monitor) {
        if (monitor.name !== name) {
            monitor.name = name;
            configChanged = true;
        }
        if (stableToken && monitor.pushToken !== stableToken) {
            monitor.pushToken = stableToken;
            configChanged = true;
        }
        if (monitor.description !== MANAGED_DESCRIPTION) {
            monitor.description = MANAGED_DESCRIPTION;
            configChanged = true;
        }
        if (monitor.interval !== desiredInterval) {
            monitor.interval = desiredInterval;
            configChanged = true;
        }
        if (monitor.retryInterval !== desiredRetryInterval) {
            monitor.retryInterval = desiredRetryInterval;
            configChanged = true;
        }
        if (monitor.resendInterval !== desiredResendInterval) {
            monitor.resendInterval = desiredResendInterval;
            configChanged = true;
        }
        if (monitor.maxretries !== desiredMaxretries) {
            monitor.maxretries = desiredMaxretries;
            configChanged = true;
        }
        if (configChanged) {
            monitor.validate();
            await R.store(monitor);
            log.info("remote-agent", `Updated child monitor #${monitor.id} under group #${groupID}`);
        }
    } else {
        monitor = R.dispense("monitor");
        monitor.user_id = userID;
        monitor.name = name;
        monitor.parent = groupID;
        monitor.type = "push";
        monitor.pushToken = stableToken || genSecret(32);
        monitor.description = MANAGED_DESCRIPTION;
        monitor.interval = desiredInterval;
        monitor.retryInterval = desiredRetryInterval;
        monitor.resendInterval = desiredResendInterval;
        monitor.maxretries = desiredMaxretries;
        monitor.accepted_statuscodes_json = JSON.stringify(["200-299"]);
        monitor.active = 1;
        monitor.validate();

        await R.store(monitor);
        isNewMonitor = true;

        log.info("remote-agent", `Created child monitor #${monitor.id} "${name}" under group #${groupID}`);
    }

    const server = UptimeKumaServer.getInstance();
    const io = server.io;

    const previousHeartbeat = await Monitor.getPreviousHeartbeat(monitor.id);
    const isFirstBeat = !previousHeartbeat;

    let bean = R.dispense("heartbeat");
    bean.time = R.isoDateTimeMillis(dayjs.utc());
    bean.monitor_id = monitor.id;
    bean.ping = ping;
    bean.msg = msg;
    bean.downCount = previousHeartbeat?.downCount || 0;

    if (previousHeartbeat) {
        bean.duration = dayjs(bean.time).diff(dayjs(previousHeartbeat.time), "second");
    }

    if (await Monitor.isUnderMaintenance(monitor.id)) {
        bean.status = MAINTENANCE;
    } else {
        Monitor.determineStatus(statusFromParam, previousHeartbeat, monitor.maxretries, false, bean);
    }

    const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitor.id);
    const endTimeDayjs = await uptimeCalculator.update(bean.status, parseFloat(bean.ping));
    bean.end_time = R.isoDateTimeMillis(endTimeDayjs);

    bean.important = Monitor.isImportantBeat(isFirstBeat, previousHeartbeat?.status, bean.status);

    if (Monitor.isImportantForNotification(isFirstBeat, previousHeartbeat?.status, bean.status)) {
        bean.downCount = 0;
        await Monitor.sendNotification(isFirstBeat, monitor, bean);
    } else if (bean.status === DOWN && monitor.resendInterval > 0) {
        ++bean.downCount;
        if (bean.downCount >= monitor.resendInterval) {
            await Monitor.sendNotification(isFirstBeat, monitor, bean);
            bean.downCount = 0;
        }
    }

    await R.store(bean);

    io.to(userID).emit("heartbeat", bean.toJSON());
    Monitor.sendStats(io, monitor.id, userID);

    if (isNewMonitor || configChanged) {
        // Restart so the watchdog picks up the (possibly new)
        // interval/retryInterval instead of continuing on stale ones held
        // by the already-running in-memory monitor instance.
        await startAutoCreatedMonitor(monitor);
    }
}

/**
 * Register an auto-created monitor (group or child) with the running server
 * and start its own check/watchdog loop, mirroring what happens when a
 * monitor is added through the UI.
 * @param {Bean} monitor Monitor bean, already stored
 * @returns {Promise<void>}
 */
async function startAutoCreatedMonitor(monitor) {
    const server = UptimeKumaServer.getInstance();

    if (monitor.id in server.monitorList) {
        await server.monitorList[monitor.id].stop();
    }

    server.monitorList[monitor.id] = monitor;
    await monitor.start(server.io);
}

module.exports = {
    ingestAgentBatch,
};
