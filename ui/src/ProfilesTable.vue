<script setup lang="ts">
/**
 * Node Profiles, the collection. What every node shares is said once in the
 * header; the table keeps the columns that differ and puts the nodes with a
 * problem first. A row opens the node's profile in the side panel.
 */
import { computed, ref } from "vue";
import { ServerCog } from "@lucide/vue";

import {
  collectorText,
  collectorTone,
  coreText,
  inboundText,
  ownershipText,
  profileHead,
  profileIssues,
  profileName,
  sortProfiles,
  type Profile,
} from "./profilesModel";
import { pageRows } from "./vpnModel";

const props = defineProps<{
  profiles: Profile[];
  openProfile?: string;
}>();
const emit = defineEmits<{ open: [profile: Profile] }>();

const head = computed(() => profileHead(props.profiles));
const sorted = computed(() => sortProfiles(props.profiles));
const compact = computed(() => Object.values(head.value.show).filter(Boolean).length <= 2);
const exceptions = computed(() => sorted.value.filter((profile) => profileIssues(profile).length).length);

const PAGE = 50;
const page = ref(1);
const pager = computed(() => pageRows(sorted.value, page.value, PAGE));

function issueText(profile: Profile): { text: string; tone: string; more: number } | undefined {
  const issues = profileIssues(profile);
  if (!issues.length) return undefined;
  return { text: issues[0].text, tone: issues[0].tone, more: issues.length - 1 };
}
</script>

<template>
  <!-- With every shared value in the header, production leaves two columns:
       the panel narrows to them instead of stretching them to opposite edges. -->
  <section class="data-panel profiles-panel" :data-compact="compact || undefined" aria-labelledby="profiles-title">
    <header class="panel-header lines-header">
      <div>
        <h2 id="profiles-title">Node profiles</h2>
        <p v-if="profiles.length" class="lines-state">
          <span v-if="exceptions" class="status-dot" data-tone="warning">{{ exceptions }} {{ exceptions === 1 ? 'node needs' : 'nodes need' }} a look, listed first</span>
          <strong v-else>{{ profiles.length }} {{ profiles.length === 1 ? 'node' : 'nodes' }}, nothing to fix</strong>
        </p>
        <p v-if="head.shared.length" class="users-notes">Every node: {{ head.shared.join(' · ') }}</p>
      </div>
    </header>
    <div v-if="profiles.length" class="table-wrap">
      <table class="lines-table profiles-table">
        <thead><tr>
          <th class="sticky-first line-col">Node</th>
          <th v-if="head.show.core">Core</th>
          <th v-if="head.show.ownership">Ownership</th>
          <th class="num">Inbounds</th>
          <th v-if="head.show.collector">Collector</th>
          <th v-if="head.show.path">Config path</th>
          <th v-if="head.show.issue">Needs</th>
        </tr></thead>
        <tbody>
          <tr v-for="profile in pager.rows" :key="profile.node_id" class="clickable-row" :data-selected="openProfile === profile.node_id || undefined" @click="emit('open', profile)">
            <td class="sticky-first line-col">
              <!-- The node id is a machine key: it lives in the title and the panel, not under every name (design 23, 3.10). -->
              <button class="row-open" type="button" :data-profile-open="profile.node_id" @click.stop="emit('open', profile)"><strong :title="profile.node_name ? `${profile.node_name} (${profile.node_id})` : profile.node_id">{{ profileName(profile) }}</strong></button>
              <!-- On a phone the Needs column is off screen; the reason rides under the name. -->
              <small v-if="issueText(profile)" class="narrow-only" :class="issueText(profile)!.tone === 'error' ? 'error-text' : 'warn-text'">{{ issueText(profile)!.text }}</small>
            </td>
            <td v-if="head.show.core" class="mono">{{ coreText(profile) }}</td>
            <td v-if="head.show.ownership"><span class="status-dot" :data-tone="profile.managed ? (profile.applied ? 'healthy' : 'warning') : 'neutral'">{{ ownershipText(profile) }}</span></td>
            <td class="num mono">{{ inboundText(profile) }}</td>
            <td v-if="head.show.collector"><span class="status-dot" :data-tone="collectorTone(profile)">{{ collectorText(profile) }}</span></td>
            <td v-if="head.show.path" class="mono" :title="profile.config_path">{{ profile.config_path || 'not reported' }}</td>
            <td v-if="head.show.issue" class="issue-cell">
              <template v-if="issueText(profile)">
                <span :class="issueText(profile)!.tone === 'error' ? 'error-text' : 'warn-text'" :title="profileIssues(profile).map((issue) => issue.text).join('\n')">{{ issueText(profile)!.text }}</span>
                <small v-if="issueText(profile)!.more">and {{ issueText(profile)!.more }} more</small>
              </template>
              <span v-else data-unknown="true">nothing</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty-state">
      <ServerCog :size="26" aria-hidden="true" />
      <strong>No node profiles</strong>
      <p>A profile appears once a node either runs a Lattice-managed core or reports a discovery result. If the fleet has nodes but this is empty, their agents have not reported a sing-box or Xray runtime yet.</p>
    </div>
    <footer v-if="pager.pages > 1" class="table-pagination" aria-label="Profiles pagination">
      <span>Nodes {{ pager.from }} to {{ pager.to }} of {{ pager.total }}</span>
      <button class="button button-secondary button-compact" type="button" :disabled="pager.page === 1" @click="page = pager.page - 1">Previous</button>
      <span>Page {{ pager.page }} of {{ pager.pages }}</span>
      <button class="button button-secondary button-compact" type="button" :disabled="pager.page === pager.pages" @click="page = pager.page + 1">Next</button>
    </footer>
  </section>
</template>
