<script setup lang="ts">
import { onMounted, ref } from "vue";
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
  loadDevices,
  scan,
  continueScan,
  finishScan,
} = useScanner(client);

const selected = ref("");

onMounted(loadDevices);

function start() {
  const device = devices.value.find((d) => d.id === selected.value);
  if (!device) return;
  void scan({
    device_id: device.id,
    backend: device.backend,
    dpi: 200,
    source: "flatbed",
    output_format: "pdf",
    max_pages: 2,
    preset: "bw_document",
  });
}

function resultUrl(blob: Blob) {
  return URL.createObjectURL(blob);
}
</script>

<template>
  <div>
    <button @click="loadDevices">Refresh devices</button>
    <select v-model="selected">
      <option value="">Select scanner…</option>
      <option v-for="d in devices" :key="d.id" :value="d.id">
        [{{ d.backend }}] {{ d.name }}
      </option>
    </select>
    <button :disabled="!selected" @click="start">Scan</button>

    <p>status: {{ status }} ({{ pageCount }}/{{ maxPages }})</p>

    <div v-if="awaitingPage">
      <p>Swap the document on the glass, then continue.</p>
      <button @click="continueScan">Continue</button>
      <button @click="finishScan">Finish now</button>
    </div>

    <p v-if="error" style="color: red">Error: {{ error.message }}</p>

    <a v-if="result" :href="resultUrl(result)" download="scan.pdf">Download scan.pdf</a>
  </div>
</template>
