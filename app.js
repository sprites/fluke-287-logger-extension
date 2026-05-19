const state = {
      port: null,
      writer: null,
      reader: null,
      readLoopRunning: false,
      buffer: '',
      pendingLines: [],
      pendingResolvers: [],
      availablePorts: [],
      selectedPortKey: '',
      samples: [],
      recording: false,
      pollTimer: null,
      pollInFlight: false,
      lastUnit: '',
      lastCommand: 'QM',
    };

    const els = {
      connectBtn: document.getElementById('connectBtn'),
      disconnectBtn: document.getElementById('disconnectBtn'),
      portSelect: document.getElementById('portSelect'),
      refreshPortsBtn: document.getElementById('refreshPortsBtn'),
      pickPortBtn: document.getElementById('pickPortBtn'),
      recordBtn: document.getElementById('recordBtn'),
      singleBtn: document.getElementById('singleBtn'),
      exportBtn: document.getElementById('exportBtn'),
      clearBtn: document.getElementById('clearBtn'),
      commandSelect: document.getElementById('commandSelect'),
      intervalInput: document.getElementById('intervalInput'),
      statusText: document.getElementById('statusText'),
      statusDot: document.getElementById('statusDot'),
      lastValue: document.getElementById('lastValue'),
      lastUnit: document.getElementById('lastUnit'),
      sampleCount: document.getElementById('sampleCount'),
      lastTime: document.getElementById('lastTime'),
      chartLabel: document.getElementById('chartLabel'),
      modePill: document.getElementById('modePill'),
      tableBody: document.getElementById('tableBody'),
      chart: document.getElementById('chart'),
    };

    const ctx = els.chart.getContext('2d');
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const STORAGE_KEY = 'fluke287-logger-settings';

    function setStatus(text, tone = 'bad') {
      els.statusText.textContent = text;
      const colors = {
        good: ['#22c55e', '0 0 0 4px rgba(34, 197, 94, 0.14)'],
        warn: ['#fbbf24', '0 0 0 4px rgba(251, 191, 36, 0.14)'],
        bad: ['#ef4444', '0 0 0 4px rgba(239, 68, 68, 0.12)'],
        neutral: ['#8ea0ba', '0 0 0 4px rgba(148, 163, 184, 0.10)'],
      };
      const [fill, shadow] = colors[tone] || colors.neutral;
      els.statusDot.style.background = fill;
      els.statusDot.style.boxShadow = shadow;
    }

    function setMode(text) {
      els.modePill.textContent = text;
    }

    function formatTime(ts) {
      return new Date(ts).toLocaleTimeString('de-CH', { hour12: false });
    }

    function formatFullTime(ts) {
      return new Date(ts).toLocaleString('de-CH', { hour12: false });
    }

    function loadSettings() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        return JSON.parse(raw) || {};
      } catch {
        return {};
      }
    }

    function saveSettings(next) {
      const current = loadSettings();
      const merged = { ...current, ...next };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {}
      return merged;
    }

    function portKeyFromInfo(info = {}) {
      const vendor = info.usbVendorId != null ? String(info.usbVendorId).padStart(4, '0') : '----';
      const product = info.usbProductId != null ? String(info.usbProductId).padStart(4, '0') : '----';
      return `${vendor}:${product}`;
    }

    function describePort(port) {
      const info = port.getInfo ? port.getInfo() : {};
      const vendor = info.usbVendorId != null ? `VID ${String(info.usbVendorId).padStart(4, '0')}` : null;
      const product = info.usbProductId != null ? `PID ${String(info.usbProductId).padStart(4, '0')}` : null;
      const parts = [vendor, product].filter(Boolean);
      return parts.length ? parts.join(' ') : 'Serieller Port';
    }

    function rememberActivePort(port) {
      const info = port.getInfo ? port.getInfo() : {};
      const key = portKeyFromInfo(info);
      state.selectedPortKey = key;
      saveSettings({ selectedPortKey: key, lastCommand: state.lastCommand, interval: Number(els.intervalInput.value) || 1000 });
    }

    function restoreSettings() {
      const settings = loadSettings();
      if (settings.lastCommand && ['QM', 'QDDA'].includes(settings.lastCommand)) {
        state.lastCommand = settings.lastCommand;
        els.commandSelect.value = settings.lastCommand;
      }
      if (settings.interval) {
        els.intervalInput.value = String(settings.interval);
      }
      if (settings.selectedPortKey) {
        state.selectedPortKey = settings.selectedPortKey;
      }
    }

    async function refreshPorts(preferredKey = '') {
      if (!navigator.serial?.getPorts) {
        els.portSelect.innerHTML = '<option value="">Web Serial nicht verfuegbar</option>';
        return [];
      }

      const ports = await navigator.serial.getPorts();
      state.availablePorts = ports.map((port) => {
        const info = port.getInfo ? port.getInfo() : {};
        return {
          port,
          key: portKeyFromInfo(info),
          label: describePort(port),
          info,
        };
      });

      const selectedKey = preferredKey || state.selectedPortKey || loadSettings().selectedPortKey || '';
      els.portSelect.innerHTML = state.availablePorts.length
        ? state.availablePorts.map((entry) => `<option value="${escapeHtml(entry.key)}">${escapeHtml(entry.label)} (${escapeHtml(entry.key)})</option>`).join('')
        : '<option value="">Noch keine freigegebenen Ports</option>';

      const match = state.availablePorts.find((entry) => entry.key === selectedKey) || (selectedKey ? null : state.availablePorts[0] || null);
      if (match) {
        els.portSelect.value = match.key;
        state.selectedPortKey = match.key;
      } else {
        els.portSelect.value = '';
      }

      return state.availablePorts;
    }

    function findSelectedPort() {
      const selectedKey = els.portSelect.value || state.selectedPortKey || loadSettings().selectedPortKey || '';
      return state.availablePorts.find((entry) => entry.key === selectedKey) || null;
    }

    async function pickNewPort() {
      if (!('serial' in navigator)) {
        throw new Error('Web Serial wird von diesem Browser nicht unterstützt.');
      }
      const port = await navigator.serial.requestPort();
      await openPort(port);
      rememberActivePort(port);
      await refreshPorts(state.selectedPortKey);
      return port;
    }

    async function openSelectedPort() {
      const selected = findSelectedPort();
      if (!selected) {
        return pickNewPort();
      }
      await openPort(selected.port);
      rememberActivePort(selected.port);
      await refreshPorts(state.selectedPortKey);
      return selected.port;
    }

    function sanitizeNumberText(text) {
      if (typeof text !== 'string') return null;
      const cleaned = text.trim();
      if (!cleaned) return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }

    function parseQMLine(line) {
      const parts = line.split(',').map((part) => part.trim());
      if (parts.length < 4) return null;
      const value = sanitizeNumberText(parts[0]);
      return {
        value,
        unit: parts[1] || '',
        state: parts[2] || '',
        attribute: parts[3] || '',
        raw: line,
      };
    }

    function parseQDDA(line) {
      const parts = line.split(',').map((part) => part.trim());
      if (parts.length < 8) return null;
      const firstReadingIndex = parts.findIndex((part, idx) => idx > 0 && /E|^[+\-]?\d/.test(part));
      const value = sanitizeNumberText(parts[firstReadingIndex > 0 ? firstReadingIndex : 0]);
      const unit = parts[firstReadingIndex > 0 ? firstReadingIndex + 2 : 1] || '';
      const state = parts[firstReadingIndex > 0 ? firstReadingIndex + 6 : 2] || '';
      const attribute = parts[firstReadingIndex > 0 ? firstReadingIndex + 7 : 3] || '';
      return {
        value,
        unit,
        state,
        attribute,
        raw: line,
      };
    }

    function parseMeterLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return null;

      if (/^(?:0|1|2|5)$/.test(trimmed) && !trimmed.includes(',')) {
        return { ack: trimmed };
      }

      if (trimmed.includes(',')) {
        return state.lastCommand === 'QDDA' ? parseQDDA(trimmed) : parseQMLine(trimmed);
      }

      if (/^[+\-]?\d/.test(trimmed)) {
        const value = sanitizeNumberText(trimmed);
        return { value, unit: '', state: 'NORMAL', attribute: '', raw: trimmed };
      }

      return null;
    }

    function pushLine(line) {
      const waiter = state.pendingResolvers.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        state.pendingLines.push(line);
      }
    }

    function nextLine(timeoutMs = 2000) {
      if (state.pendingLines.length) {
        return Promise.resolve(state.pendingLines.shift());
      }
      return new Promise((resolve) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            const index = state.pendingResolvers.indexOf(waiter);
            if (index !== -1) state.pendingResolvers.splice(index, 1);
            resolve(null);
          }, timeoutMs),
        };
        state.pendingResolvers.push(waiter);
      });
    }

    async function startReadLoop() {
      if (!state.port?.readable || state.readLoopRunning) return;
      state.readLoopRunning = true;
      state.reader = state.port.readable.getReader();
      try {
        while (state.readLoopRunning) {
          const { value, done } = await state.reader.read();
          if (done) break;
          if (!value) continue;
          state.buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = state.buffer.search(/[\r\n]/)) !== -1) {
            const line = state.buffer.slice(0, idx);
            state.buffer = state.buffer.slice(idx + 1).replace(/^[\r\n]+/, '');
            if (line.length || state.buffer.length === 0) {
              pushLine(line);
            }
          }
        }
      } finally {
        state.readLoopRunning = false;
        try { state.reader?.releaseLock(); } catch {}
        state.reader = null;
      }
    }

    async function openPort(port) {
      await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      state.port = port;
      state.writer = port.writable.getWriter();
      startReadLoop().catch((error) => {
        console.error(error);
        setStatus(error.message || 'Leseprozess beendet', 'warn');
      });
    }

    async function closePort() {
      stopRecording();
      state.readLoopRunning = false;
      try { await state.reader?.cancel(); } catch {}
      try { state.writer?.releaseLock(); } catch {}
      state.writer = null;
      try { await state.port?.close(); } catch {}
      state.port = null;
      setStatus('Nicht verbunden', 'bad');
      setMode('bereit');
      els.connectBtn.disabled = false;
      els.disconnectBtn.disabled = true;
      els.recordBtn.disabled = true;
      els.singleBtn.disabled = true;
      els.exportBtn.disabled = state.samples.length === 0;
    }

    async function sendCommand(command) {
      if (!state.writer) throw new Error('Keine serielle Verbindung');
      state.lastCommand = command;
      await state.writer.write(encoder.encode(`${command}\r`));
      const lines = [];
      const timeoutMs = 2000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = Math.max(50, deadline - Date.now());
        const line = await nextLine(remaining);
        if (line == null) break;
        if (line === '') continue;
        lines.push(line);
        if (lines.length >= 2) break;
      }
      return lines;
    }

    function coerceSample(parsed) {
      if (!parsed) return null;
      if (parsed.ack && parsed.ack !== '0') {
        throw new Error(`Meter-Antwort: ${parsed.ack}`);
      }
      if (typeof parsed.value !== 'number' || Number.isNaN(parsed.value)) return null;
      return {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        value: parsed.value,
        unit: parsed.unit || state.lastUnit || '',
        state: parsed.state || '',
        attribute: parsed.attribute || '',
        raw: parsed.raw || '',
      };
    }

    async function probeMeterProtocol() {
      const candidates = ['QM', 'QDDA'];
      for (const command of candidates) {
        try {
          const lines = await sendCommand(command);
          const parsed = lines.map(parseMeterLine).find((item) => typeof item?.value === 'number');
          if (parsed) {
            state.lastCommand = command;
            els.commandSelect.value = command;
            saveSettings({ lastCommand: command });
            return command;
          }
        } catch (error) {
          console.warn(`Probe ${command} fehlgeschlagen`, error);
        }
      }
      return null;
    }

    function addSample(sample) {
      state.samples.push(sample);
      state.lastUnit = sample.unit || state.lastUnit;
      els.lastValue.textContent = Number.isFinite(sample.value) ? sample.value.toPrecision(8).replace(/\.?0+$/, '') : 'OL';
      els.lastUnit.textContent = sample.unit || '-';
      els.sampleCount.textContent = String(state.samples.length);
      els.lastTime.textContent = formatFullTime(sample.timestamp);
      els.chartLabel.textContent = `${sample.unit || 'Wert'} · ${state.samples.length} Punkte`;
      els.exportBtn.disabled = false;
      renderTable();
      renderChart();
    }

    function renderTable() {
      if (!state.samples.length) {
        els.tableBody.innerHTML = '<tr><td colspan="5" class="hint" style="padding: 1rem 0.8rem;">Noch keine Messung erfasst.</td></tr>';
        return;
      }

      const rows = state.samples.slice().reverse().map((sample) => {
        const value = Number.isFinite(sample.value) ? sample.value.toPrecision(8).replace(/\.?0+$/, '') : 'OL';
        return `<tr>
          <td>${formatTime(sample.timestamp)}</td>
          <td>${value}</td>
          <td>${escapeHtml(sample.unit || '')}</td>
          <td>${escapeHtml(sample.state || '')}</td>
          <td>${escapeHtml(sample.attribute || '')}</td>
        </tr>`;
      }).join('');

      els.tableBody.innerHTML = rows;
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function resizeCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const rect = els.chart.getBoundingClientRect();
      const width = Math.max(300, Math.floor(rect.width * dpr));
      const height = Math.max(260, Math.floor(rect.height * dpr));
      if (els.chart.width !== width || els.chart.height !== height) {
        els.chart.width = width;
        els.chart.height = height;
      }
      renderChart();
    }

    function renderChart() {
      const width = els.chart.width;
      const height = els.chart.height;
      ctx.clearRect(0, 0, width, height);

      const pad = { left: 72, right: 20, top: 24, bottom: 48 };
      const plot = {
        x: pad.left,
        y: pad.top,
        w: width - pad.left - pad.right,
        h: height - pad.top - pad.bottom,
      };

      drawGrid(plot, pad);

      const series = state.samples.filter((sample) => Number.isFinite(sample.value));
      if (!series.length) {
        ctx.fillStyle = '#8ea0ba';
        ctx.font = '16px ' + getComputedStyle(document.body).fontFamily;
        ctx.fillText('Keine gültigen Messwerte', plot.x + 18, plot.y + 30);
        return;
      }

      const xs = series.map((d) => d.timestamp);
      const ys = series.map((d) => d.value);
      let minY = Math.min(...ys);
      let maxY = Math.max(...ys);
      if (minY === maxY) {
        const delta = Math.abs(minY) || 1;
        minY -= delta * 0.5;
        maxY += delta * 0.5;
      } else {
        const padY = (maxY - minY) * 0.1;
        minY -= padY;
        maxY += padY;
      }

      const minX = xs[0];
      const maxX = xs[xs.length - 1] || minX + 1;
      const xSpan = Math.max(1, maxX - minX);
      const ySpan = Math.max(1e-12, maxY - minY);

      const xOf = (ts) => plot.x + ((ts - minX) / xSpan) * plot.w;
      const yOf = (v) => plot.y + plot.h - ((v - minY) / ySpan) * plot.h;

      ctx.save();
      ctx.strokeStyle = 'rgba(79, 209, 197, 0.95)';
      ctx.lineWidth = 3 * (window.devicePixelRatio || 1);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      series.forEach((sample, i) => {
        const x = xOf(sample.timestamp);
        const y = yOf(sample.value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      ctx.fillStyle = 'rgba(79, 209, 197, 0.18)';
      ctx.beginPath();
      ctx.moveTo(xOf(series[0].timestamp), plot.y + plot.h);
      series.forEach((sample) => ctx.lineTo(xOf(sample.timestamp), yOf(sample.value)));
      ctx.lineTo(xOf(series[series.length - 1].timestamp), plot.y + plot.h);
      ctx.closePath();
      ctx.fill();

      series.forEach((sample) => {
        const x = xOf(sample.timestamp);
        const y = yOf(sample.value);
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(x, y, 4.5 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.95)';
        ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
        ctx.beginPath();
        ctx.arc(x, y, 4.5 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.restore();

      drawAxesLabels(plot, minY, maxY, minX, maxX);
    }

    function drawGrid(plot, pad) {
      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.60)';
      ctx.lineWidth = 1;

      const yTicks = 5;
      for (let i = 0; i <= yTicks; i++) {
        const y = plot.y + (plot.h / yTicks) * i;
        ctx.beginPath();
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.w, y);
        ctx.stroke();
      }

      const xTicks = 6;
      for (let i = 0; i <= xTicks; i++) {
        const x = plot.x + (plot.w / xTicks) * i;
        ctx.beginPath();
        ctx.moveTo(x, plot.y);
        ctx.lineTo(x, plot.y + plot.h);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
      ctx.restore();
    }

    function drawAxesLabels(plot, minY, maxY, minX, maxX) {
      ctx.save();
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;

      const yTicks = 5;
      for (let i = 0; i <= yTicks; i++) {
        const value = maxY - (i / yTicks) * (maxY - minY);
        const y = plot.y + (plot.h / yTicks) * i;
        ctx.fillText(formatAxisValue(value), 14, y + 4);
      }

      const xTicks = 6;
      for (let i = 0; i <= xTicks; i++) {
        const ts = minX + (i / xTicks) * Math.max(1, maxX - minX);
        const x = plot.x + (plot.w / xTicks) * i;
        ctx.fillText(new Date(ts).toLocaleTimeString('de-CH', { hour12: false, minute: '2-digit', second: '2-digit' }), x - 28, plot.y + plot.h + 22);
      }

      ctx.fillStyle = '#8ea0ba';
      ctx.fillText('Zeit', plot.x + plot.w - 18, plot.y + plot.h + 38);
      if (state.samples.length) {
        const unit = state.samples[state.samples.length - 1].unit || '';
        ctx.fillText(unit, plot.x + 2, plot.y - 8);
      }
      ctx.restore();
    }

    function formatAxisValue(value) {
      const abs = Math.abs(value);
      if ((abs !== 0 && (abs < 0.001 || abs >= 10000))) return value.toExponential(2);
      return value.toFixed(4).replace(/\.?0+$/, '');
    }

    async function pollOnce() {
      if (!state.port || state.pollInFlight) return;
      state.pollInFlight = true;
      try {
        const lines = await sendCommand(els.commandSelect.value);
        const responses = lines.map(parseMeterLine).filter(Boolean);
        const parsed = responses.find((item) => typeof item.value === 'number');
        if (!parsed) {
          const ack = responses.find((item) => item.ack);
          if (ack && ack.ack !== '0') throw new Error(`Meter-Antwort: ${ack.ack}`);
          return;
        }
        const sample = coerceSample(parsed);
        if (sample) addSample(sample);
      } finally {
        state.pollInFlight = false;
      }
    }

    function startRecording() {
      if (!state.port) return;
      state.recording = true;
      els.recordBtn.innerHTML = iconButtonLabel('Pause', 'pause');
      els.recordBtn.classList.remove('primary');
      setMode('läuft');
      setStatus('Verbunden', 'good');
      const interval = Math.max(100, Number(els.intervalInput.value) || 1000);
      stopTimer();
      state.pollTimer = setInterval(() => {
        pollOnce().catch((error) => {
          console.error(error);
          setStatus(error.message || 'Messfehler', 'warn');
          setMode('Fehler');
        });
      }, interval);
      pollOnce().catch((error) => {
        console.error(error);
        setStatus(error.message || 'Messfehler', 'warn');
        setMode('Fehler');
      });
    }

    function stopRecording() {
      state.recording = false;
      stopTimer();
      els.recordBtn.innerHTML = iconButtonLabel('Start', 'record');
      els.recordBtn.classList.add('primary');
      if (state.port) {
        setMode('bereit');
        setStatus('Verbunden', 'good');
      }
    }

    function stopTimer() {
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = null;
    }

    function iconButtonLabel(text, kind) {
      const icons = {
        record: '<svg class="svg-icon" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
        pause: '<svg class="svg-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="6" width="3.5" height="12" rx="1"/><rect x="13.5" y="6" width="3.5" height="12" rx="1"/></svg>',
      };
      return `${icons[kind] || ''}${text}`;
    }

    function exportCsv() {
      if (!state.samples.length) return;
      const header = ['iso_timestamp', 'local_timestamp', 'value', 'unit', 'state', 'attribute', 'raw'];
      const lines = [header.join(',')];
      for (const sample of state.samples) {
        lines.push([
          csv(sample.iso),
          csv(formatFullTime(sample.timestamp)),
          csv(Number.isFinite(sample.value) ? String(sample.value) : ''),
          csv(sample.unit || ''),
          csv(sample.state || ''),
          csv(sample.attribute || ''),
          csv(sample.raw || ''),
        ].join(','));
      }
      const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fluke-287-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }

    function csv(value) {
      const text = String(value ?? '');
      if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
      return text;
    }

    function clearData() {
      state.samples = [];
      state.lastUnit = '';
      els.lastValue.textContent = '-';
      els.lastUnit.textContent = '-';
      els.sampleCount.textContent = '0';
      els.lastTime.textContent = '-';
      els.chartLabel.textContent = 'Keine Daten';
      els.exportBtn.disabled = true;
      renderTable();
      renderChart();
    }

    async function connectToMeter() {
      if (!('serial' in navigator)) {
        throw new Error('Web Serial wird von diesem Browser nicht unterstützt.');
      }

      await refreshPorts();
      let port;
      const selected = findSelectedPort();
      if (selected) {
        port = await openSelectedPort();
      } else {
        port = await pickNewPort();
      }

      await probeMeterProtocol();
      setStatus(`Verbunden: ${describePort(port)}`, 'good');
      setMode('bereit');
      els.disconnectBtn.disabled = false;
      els.recordBtn.disabled = false;
      els.singleBtn.disabled = false;
      els.exportBtn.disabled = state.samples.length === 0;
      return port;
    }

    els.connectBtn.addEventListener('click', async () => {
      try {
        const port = await connectToMeter();
        els.connectBtn.disabled = true;
        els.disconnectBtn.disabled = false;
        els.recordBtn.disabled = false;
        els.singleBtn.disabled = false;
        setStatus(`Verbunden: ${describePort(port)}`, 'good');
        setMode('bereit');
      } catch (error) {
        console.error(error);
        setStatus(error.message || 'Verbindung fehlgeschlagen', 'warn');
      }
    });

    els.disconnectBtn.addEventListener('click', async () => {
      await closePort();
      await refreshPorts();
      els.connectBtn.disabled = false;
    });

    els.recordBtn.addEventListener('click', () => {
      if (!state.port) return;
      if (state.recording) stopRecording();
      else startRecording();
    });

    els.singleBtn.addEventListener('click', () => {
      pollOnce().catch((error) => {
        console.error(error);
        setStatus(error.message || 'Messfehler', 'warn');
        setMode('Fehler');
      });
    });

    els.exportBtn.addEventListener('click', exportCsv);
    els.clearBtn.addEventListener('click', clearData);

    els.commandSelect.addEventListener('change', () => {
      state.lastCommand = els.commandSelect.value;
      saveSettings({ lastCommand: state.lastCommand });
      setStatus(state.port ? `Verbunden: ${describePort(state.port)}` : 'Nicht verbunden', state.port ? 'good' : 'bad');
    });

    els.intervalInput.addEventListener('change', () => {
      saveSettings({ interval: Number(els.intervalInput.value) || 1000 });
    });

    els.portSelect.addEventListener('change', () => {
      state.selectedPortKey = els.portSelect.value;
      saveSettings({ selectedPortKey: state.selectedPortKey });
    });

    els.refreshPortsBtn.addEventListener('click', () => {
      refreshPorts(state.selectedPortKey).catch((error) => {
        console.error(error);
        setStatus(error.message || 'Ports konnten nicht geladen werden', 'warn');
      });
    });

    els.pickPortBtn.addEventListener('click', () => {
      pickNewPort().catch((error) => {
        console.error(error);
        setStatus(error.message || 'Portauswahl fehlgeschlagen', 'warn');
      });
    });

    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('beforeunload', () => {
      stopTimer();
      if (state.writer) {
        try { state.writer.releaseLock(); } catch {}
      }
    });

    navigator.serial?.addEventListener?.('connect', () => {
      refreshPorts(state.selectedPortKey).catch(() => {});
    });

    navigator.serial?.addEventListener?.('disconnect', () => {
      refreshPorts(state.selectedPortKey).catch(() => {});
    });

    restoreSettings();
    renderTable();
    resizeCanvas();
    refreshPorts(state.selectedPortKey).catch(() => {});
    setStatus('Nicht verbunden', 'neutral');
    setMode('bereit');
  