<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ScannerClient } from "web-scanner-client";
import { useScanner } from "web-scanner-client/vue";

const client = new ScannerClient();
const {
  devices,
  status,
  pageCount,
  maxPages,
  awaitingPage,
  result,
  error,
  warnings,
  loadDevices,
  scan,
  continueScan,
  finishScan,
  reset,
} = useScanner(client);

const selected = ref("");
const devicesError = ref<Error | null>(null);

const scanning = computed(
  () => status.value !== "idle" && status.value !== "done" && status.value !== "error",
);

const resultUrl = computed(() =>
  result.value ? URL.createObjectURL(result.value) : null,
);

async function refreshDevices() {
  devicesError.value = null;
  try {
    await loadDevices();
  } catch (err) {
    devicesError.value = err instanceof Error ? err : new Error(String(err));
  }
}

onMounted(refreshDevices);

function start() {
  const device = devices.value.find((d) => d.id === selected.value);
  if (!device) return;
  void scan({
    device_id: device.id,
    backend: device.backend,
    dpi: 200,
    source: "flatbed",
    output_format: "pdf",
    max_pages: 2, // exercise the page-swap flow; use max_pages: 1 with png/jpeg
    preset: "bw_document",
  });
}
</script>

<template>
  <div>
    <button @click="refreshDevices">Refresh devices</button>
    <p v-if="devicesError" style="color: red">Devices: {{ devicesError.message }}</p>

    <select v-model="selected">
      <option value="">Select scanner…</option>
      <option v-for="d in devices" :key="d.id" :value="d.id">
        [{{ d.backend }}] {{ d.name }}
      </option>
    </select>

    <button :disabled="!selected || scanning" @click="start">
      {{ scanning ? "Scanning…" : "Scan" }}
    </button>

    <button v-if="status !== 'idle'" style="margin-left: 8px" @click="reset">Reset</button>

    <p>status: {{ status }} ({{ pageCount }}/{{ maxPages }})</p>

    <div v-if="awaitingPage">
      <p>Swap the document on the glass, then continue.</p>
      <button @click="continueScan">Continue</button>
      <button @click="finishScan">Finish now</button>
    </div>

    <p v-if="error" style="color: red">Error: {{ error.message }}</p>

    <ul v-if="warnings.length" style="color: #a16207; font-size: 0.85em">
      <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
    </ul>

    <a v-if="resultUrl" :href="resultUrl" download="scan.pdf">Download scan.pdf</a>
  </div>
</template>
