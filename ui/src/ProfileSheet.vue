<script setup lang="ts">
/**
 * Node Profiles, L2: one node's profile in the side panel, addressed by
 * `?open=<node_id>`. What the node reports first, then the sing-box
 * integration settings Lattice keeps for its agent.
 *
 * Saving writes those settings in Lattice and hands back the agent command
 * that applies them. It files no approval: the host gives a plugin no way to
 * file one, and the server has no approval kind for agent reconfiguration,
 * so the node runs its old settings until someone runs the command there.
 * The panel says that before and after the save, not only after.
 */
import { computed, nextTick, reactive, ref, watch } from "vue";
import { CircleAlert, LoaderCircle, X } from "@lucide/vue";

import {
  collectorText,
  collectorTone,
  coreText,
  ownershipText,
  profileIssues,
  profileName,
  type Profile,
  type ProfilePluginConfig,
  type ProfileSettings,
} from "./profilesModel";

const props = defineProps<{
  profile?: Profile;
  missingId?: string;
  settings?: ProfileSettings;
  settingsBusy: boolean;
  settingsError: string;
  canRead: boolean;
  canConfigure: boolean;
  saving: boolean;
  /** The agent command the last save returned. */
  command: string;
  savedAt?: string;
}>();
const emit = defineEmits<{ close: []; save: [config: ProfilePluginConfig] }>();

const form = reactive<ProfilePluginConfig>({
  singbox_discover: false, singbox_bin: "", proxy_usage_file: "", proxy_usage_url: "",
  proxy_usage_xray_api: "", proxy_usage_xray_bin: "", proxy_usage_xray_pattern: "", singbox_stats_api: "",
});

watch(() => props.settings, (value) => {
  if (!value) return;
  Object.assign(form, {
    singbox_discover: value.saved.singbox_discover,
    singbox_bin: value.saved.singbox_bin ?? "",
    proxy_usage_file: value.saved.proxy_usage_file ?? "",
    proxy_usage_url: value.saved.proxy_usage_url ?? "",
    proxy_usage_xray_api: value.saved.proxy_usage_xray_api ?? "",
    proxy_usage_xray_bin: value.saved.proxy_usage_xray_bin ?? "",
    proxy_usage_xray_pattern: value.saved.proxy_usage_xray_pattern ?? "",
    singbox_stats_api: value.saved.singbox_stats_api ?? "",
  });
}, { immediate: true });

/* Saving disables the button that had focus; the returned command takes it,
 * selected, so the keyboard stays in the panel and the command is ready to copy. */
const commandEl = ref<HTMLTextAreaElement>();
watch(() => props.command, async (value) => {
  if (!value) return;
  await nextTick();
  commandEl.value?.focus();
});

const issues = computed(() => (props.profile ? profileIssues(props.profile) : []));
const execAllowed = computed(() => !!props.settings && props.settings.prerequisites.allow_exec && !props.settings.prerequisites.no_exec);
</script>

<template>
  <div class="overlay-scrim sheet-scrim" data-overlay="profile-detail" @mousedown.self="emit('close')">
    <section tabindex="-1" class="modal sheet" role="dialog" aria-modal="true" aria-labelledby="profile-detail-title">
      <header>
        <div>
          <h2 id="profile-detail-title">{{ profile ? profileName(profile) : 'Node profile not found' }}</h2>
          <p v-if="profile">sing-box integration on this node</p>
          <p v-if="profile" class="proof-line sheet-proof">
            <span>{{ profile.node_id }}</span>
            <span>· {{ coreText(profile) }}</span>
            <span>· collector {{ collectorText(profile) }}</span>
            <span v-if="settingsBusy">· reading settings</span>
          </p>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')"><X :size="17" /></button>
      </header>

      <div v-if="!profile" class="detail-body">
        <div class="empty-state">
          <CircleAlert :size="26" aria-hidden="true" />
          <strong>This node has no profile now</strong>
          <p>No profile has the node id <span class="mono">{{ missingId }}</span>. The node may have been removed, or its agent stopped reporting a runtime.</p>
          <div class="empty-actions"><button class="button button-secondary" type="button" @click="emit('close')">Back to node profiles</button></div>
        </div>
      </div>

      <div v-else class="detail-body">
        <ul v-if="issues.length" class="issue-list" aria-label="What needs a look on this node">
          <li v-for="issue in issues" :key="issue.text" :data-tone="issue.tone"><span class="status-dot" :data-tone="issue.tone">{{ issue.tone === 'error' ? 'error' : 'warning' }}</span> {{ issue.text }}</li>
        </ul>

        <div class="detail-grid">
          <div><span>Core</span><strong class="mono">{{ coreText(profile) }}</strong><small>{{ profile.capabilities.join(', ') || 'no capability reported' }}</small></div>
          <div><span>Ownership</span><strong>{{ ownershipText(profile) }}</strong><small>{{ profile.managed ? 'Lattice writes this core config' : 'Lattice reads what the node runs' }}</small></div>
          <div><span>Inbounds</span><strong>{{ profile.inbound_count }}</strong><small>{{ profile.discovered_count }} discovered · discovery {{ profile.discovery_status || 'not reported' }}</small></div>
          <div><span>Collector</span><strong><span class="status-dot" :data-tone="collectorTone(profile)">{{ collectorText(profile) }}</span></strong><small>{{ profile.collector?.source || 'no source reported' }}</small></div>
          <div><span>Config path</span><strong class="mono">{{ profile.config_path || 'not reported' }}</strong><small>as the agent reports it</small></div>
          <div><span>Stats API</span><strong class="mono">{{ profile.stats_api || 'none' }}</strong><small>per-identity usage comes from here</small></div>
        </div>

        <section class="detail-section settings-section" aria-labelledby="profile-settings-title">
          <h3 id="profile-settings-title">Integration settings</h3>
          <p v-if="!canRead" class="field-help">This session cannot read this node's settings; that needs node read access on this node.</p>
          <template v-else>
            <div v-if="settingsError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ settingsError }}</span></div>
            <div v-if="settingsBusy" class="loading-state loading-inline"><LoaderCircle class="spin" :size="18" /> Reading this node's settings</div>
            <template v-else-if="settings">
              <div class="prerequisite-strip">
                <span class="badge" :data-tone="execAllowed ? 'info' : undefined">Task execution {{ execAllowed ? 'allowed' : 'blocked' }}</span>
                <span class="badge" :data-tone="settings.prerequisites.allow_root_exec ? 'info' : undefined">Root execution {{ settings.prerequisites.allow_root_exec ? 'allowed' : 'blocked' }}</span>
                <span class="badge" :data-tone="settings.reconfigure_required ? 'warning' : undefined">{{ settings.reconfigure_required ? 'The node runs different settings from these' : 'The node runs these settings' }}</span>
              </div>
              <div class="form-grid profile-form">
                <label class="toggle-field field-wide"><input v-model="form.singbox_discover" type="checkbox" :disabled="!canConfigure" /><span>Discover sing-box installations on this node</span></label>
                <label class="field field-wide"><span>Manager binary</span><input v-model="form.singbox_bin" class="mono" type="text" placeholder="/usr/local/bin/sb" autocomplete="off" :disabled="!canConfigure" /></label>
                <label class="field"><span>Usage file</span><input v-model="form.proxy_usage_file" class="mono" type="text" placeholder="/var/lib/sing-box/usage.json" autocomplete="off" :disabled="!canConfigure" /></label>
                <label class="field"><span>Usage URL</span><input v-model="form.proxy_usage_url" class="mono" type="url" placeholder="Absolute HTTPS collector URL" autocomplete="off" :disabled="!canConfigure" /></label>
                <label class="field"><span>Xray API</span><input v-model="form.proxy_usage_xray_api" class="mono" type="text" placeholder="127.0.0.1:10085" autocomplete="off" :disabled="!canConfigure" /></label>
                <label class="field"><span>Xray binary</span><input v-model="form.proxy_usage_xray_bin" class="mono" type="text" placeholder="/usr/local/bin/xray" autocomplete="off" :disabled="!canConfigure" /></label>
                <label class="field field-wide"><span>Xray stat pattern</span><input v-model="form.proxy_usage_xray_pattern" class="mono" type="text" autocomplete="off" :disabled="!canConfigure" /></label>
                <label class="field field-wide"><span>sing-box stats API</span><input v-model="form.singbox_stats_api" class="mono" type="text" placeholder="127.0.0.1:8080" autocomplete="off" :disabled="!canConfigure" /><small class="field-help">sing-box's experimental stats API, on loopback. Without it there are no per-identity usage numbers for this node.</small></label>
              </div>
              <p class="field-help save-note">Saving records these settings in Lattice. It sends nothing to the node and files no approval, because Lattice has no approval for agent reconfiguration yet: the node keeps its current settings until the agent command the save returns is run there.</p>
              <section v-if="command" class="detail-section" aria-labelledby="profile-command-title">
                <h3 id="profile-command-title">Run this on the node</h3>
                <p class="field-help">Saved{{ savedAt ? ` at ${savedAt}` : '' }}. The node runs its old settings until this runs there.</p>
                <textarea ref="commandEl" class="command-output mono" :value="command" readonly aria-label="Agent command that applies the saved settings" @focus="($event.target as HTMLTextAreaElement).select()" />
              </section>
            </template>
          </template>
        </section>
      </div>
      <footer v-if="profile && settings && canConfigure && !settingsBusy">
        <button class="button button-secondary" type="button" @click="emit('close')">Close</button>
        <button class="button button-primary" type="button" :disabled="saving" @click="emit('save', { ...form })"><LoaderCircle v-if="saving" class="spin" :size="15" aria-hidden="true" /> Save settings</button>
      </footer>
    </section>
  </div>
</template>
