<template>
    <div>
        <h4 class="mb-3">{{ $t("Remote Forwarding") }}</h4>

        <p class="text-muted">
            {{ $t("remoteForwardingDescription") }}
        </p>

        <div v-if="settingsLoaded" class="my-4">
            <div class="form-check form-switch mb-3">
                <input
                    id="remote-forward-enabled"
                    v-model="settings.remoteForwardEnabled"
                    class="form-check-input"
                    type="checkbox"
                    @change="saveSettings()"
                />
                <label class="form-check-label" for="remote-forward-enabled">
                    {{ $t("Enable") }}
                </label>
            </div>

            <div class="mb-3">
                <label class="form-label" for="remote-forward-url">
                    {{ $t("remoteForwardCentralUrl") }}
                </label>
                <input
                    id="remote-forward-url"
                    v-model="settings.remoteForwardCentralUrl"
                    type="text"
                    class="form-control"
                    placeholder="https://central.example.com"
                    :disabled="!settings.remoteForwardEnabled"
                    @change="saveSettings()"
                />
            </div>

            <div class="mb-3">
                <label class="form-label" for="remote-forward-api-key">
                    {{ $t("remoteForwardApiKey") }}
                </label>
                <input
                    id="remote-forward-api-key"
                    v-model="settings.remoteForwardApiKey"
                    type="password"
                    class="form-control"
                    :disabled="!settings.remoteForwardEnabled"
                    @change="saveSettings()"
                />
                <div class="form-text">
                    {{ $t("remoteForwardApiKeyHelp") }}
                </div>
            </div>

            <div class="mb-3">
                <label class="form-label" for="remote-forward-agent-name">
                    {{ $t("remoteForwardAgentName") }}
                </label>
                <input
                    id="remote-forward-agent-name"
                    v-model="settings.remoteForwardAgentName"
                    type="text"
                    class="form-control"
                    :disabled="!settings.remoteForwardEnabled"
                    @change="saveSettings()"
                />
                <div class="form-text">
                    {{ $t("remoteForwardAgentNameHelp") }}
                </div>
            </div>

            <div class="mb-3">
                <label class="form-label" for="remote-forward-tag-filter">
                    {{ $t("remoteForwardTagFilter") }}
                </label>
                <input
                    id="remote-forward-tag-filter"
                    v-model="settings.remoteForwardTagFilter"
                    type="text"
                    class="form-control"
                    :disabled="!settings.remoteForwardEnabled"
                    @change="saveSettings()"
                />
                <div class="form-text">
                    {{ $t("remoteForwardTagFilterHelp") }}
                </div>
            </div>

            <button
                class="btn btn-normal"
                type="button"
                :disabled="testing || !settings.remoteForwardEnabled || !settings.remoteForwardCentralUrl || !settings.remoteForwardApiKey"
                @click="test"
            >
                {{ testing ? $t("Testing") : $t("remoteForwardTest") }}
            </button>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            testing: false,
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
    },

    methods: {
        /**
         * Test the current Remote Forwarding config against the central instance
         * @returns {void}
         */
        test() {
            this.testing = true;
            this.$root.getSocket().emit(
                "testRemoteForward",
                {
                    centralUrl: this.settings.remoteForwardCentralUrl,
                    apiKey: this.settings.remoteForwardApiKey,
                },
                (res) => {
                    this.$root.toastRes(res);
                    this.testing = false;
                }
            );
        },
    },
};
</script>
