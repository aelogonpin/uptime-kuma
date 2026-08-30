const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const axios = require("axios");

/**
 * Handlers for the Remote Forwarding settings ("Test" button)
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.remoteForwardSocketHandler = (socket) => {
    socket.on("testRemoteForward", async (data, callback) => {
        try {
            checkLogin(socket);

            const centralUrl = String(data?.centralUrl || "").replace(/\/+$/, "");
            const apiKey = data?.apiKey;

            if (!centralUrl) {
                throw new Error("Central Instance URL is required");
            }
            if (!apiKey) {
                throw new Error("API Key is required");
            }

            await axios.get(`${centralUrl}/api/push-agent/ping`, {
                auth: {
                    username: "remote-agent",
                    password: apiKey,
                },
                timeout: 10000,
            });

            callback({
                ok: true,
                msg: "Connected Successfully.",
            });
        } catch (e) {
            let msg = e.message;

            if (e.response) {
                if (e.response.status === 401) {
                    msg = "Unauthorized: check the API Key.";
                } else {
                    msg = `HTTP ${e.response.status}: ${e.response.data?.msg || e.message}`;
                }
            }

            log.warn("remote-forward", "Test connection failed: " + msg);

            callback({
                ok: false,
                msg,
            });
        }
    });
};
