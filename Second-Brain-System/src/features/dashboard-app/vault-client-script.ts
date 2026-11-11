/**
 * ============================================================================
 * الملف: src/features/dashboard-app/vault-client-script.ts
 * القسم: Features -> Dashboard App (سكربت الخزنة والطوارئ داخل المتصفح)
 * Hint بالعربي: يدير في المتصفح: إنشاء الخزنة، فتحها وقفلها، عرض الأسرار وإضافتها وحذفها ونسخها،
 *               طباعة كتيب الطوارئ، النسخ الاحتياطي والاستعادة. كل البيانات تُعرض عبر textContent
 *               فقط (لا innerHTML) حتى لا يمكن لأي نص مخزَّن أن يتحول إلى كود.
 * ============================================================================
 */

/**
 * Hint بالعربي: دالة إرجاع سكربت المتصفح الخاص بالخزنة والطوارئ كنص يُدمج في الصفحة.
 */
export function getVaultClientScript(): string {
  return `
    let vaultStatus = { exists: false, unlocked: false, unlockedBy: null };
    let secretsCache = [];
    const CATEGORY_LABELS = {
      email_account: '📧 بريد إلكتروني', password: '🔑 حساب', api_key: '🧩 مفتاح API',
      recovery_code: '🛟 أكواد استرداد', billing: '💳 فواتير', critical_file: '📁 ملف حساس'
    };

    async function api(path, options) {
      const opts = options || {};
      const init = { method: opts.body !== undefined ? 'POST' : 'GET', credentials: 'same-origin', headers: {} };
      if (opts.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      const res = await fetch(path, init);
      let data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const err = new Error(data.error || ('خطأ ' + res.status));
        err.status = res.status;
        err.data = data;
        if (res.status === 401 && data.locked) { refreshVaultStatus(); }
        throw err;
      }
      return data;
    }

    function showOutput(boxId, text) {
      const box = document.getElementById(boxId);
      if (!box) return;
      box.hidden = false;
      box.textContent = text;
    }

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    async function refreshVaultStatus() {
      try {
        vaultStatus = await api('/api/vault/status');
      } catch (e) {
        return;
      }
      renderVaultUI();
      if (vaultStatus.unlocked) { await loadSecrets(); } else { secretsCache = []; renderAllSecretLists(); }
    }

    function renderVaultUI() {
      const s = vaultStatus;
      document.getElementById('vaultSetupBox').hidden = s.exists;
      document.getElementById('vaultUnlockBox').hidden = !s.exists || s.unlocked;
      document.getElementById('vaultOpenBox').hidden = !s.unlocked;
      document.getElementById('addSecretDetails').hidden = s.unlockedBy !== 'commander';
      const line = document.getElementById('vaultStatusLine');
      const wifeLine = document.getElementById('wifeVaultStatus');
      const telemetry = document.getElementById('telemetryVault');
      line.className = 'vault-status' + (s.unlocked ? ' unlocked' : '');
      wifeLine.className = line.className;
      if (!s.exists) {
        line.textContent = '⚠️ لم تُنشأ الخزنة بعد.';
        wifeLine.textContent = 'لم تُنشأ الخزنة على هذا الجهاز بعد. إن كان لديكِ ملف نسخة احتياطية استخدمي "استعادة نسخة احتياطية" بالأسفل.';
        telemetry.textContent = 'غير مُنشأة';
      } else if (!s.unlocked) {
        line.textContent = '🔒 الخزنة مقفلة.';
        wifeLine.textContent = '🔒 الخزنة مقفلة.';
        telemetry.textContent = 'مقفلة';
      } else {
        const who = s.unlockedBy === 'commander' ? 'بكلمة المرور الرئيسية' : 'بمفتاح الطوارئ العائلي';
        const minutes = Math.ceil((s.secondsUntilAutoLock || 0) / 60);
        line.textContent = '🔓 مفتوحة ' + who + ' — ' + s.secretsCount + ' عنصر — تُقفل تلقائياً بعد ' + minutes + ' دقيقة خمول.';
        wifeLine.textContent = '🔓 الخزنة مفتوحة — ' + s.secretsCount + ' عنصر.';
        telemetry.textContent = 'مفتوحة';
      }
    }

    async function loadSecrets() {
      try {
        const data = await api('/api/vault/secrets');
        secretsCache = data.secrets;
      } catch (e) {
        secretsCache = [];
      }
      renderAllSecretLists();
    }

    function renderAllSecretLists() {
      renderSecretsList('commanderSecretsList', true);
      renderSecretsList('wifeSecretsList', false);
    }

    function renderSecretsList(containerId, commanderView) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.replaceChildren();
      if (!vaultStatus.unlocked) return;
      const searchInput = document.getElementById('secretSearch');
      const term = commanderView && searchInput ? searchInput.value.trim().toLowerCase() : '';
      const items = secretsCache.filter(function (s) {
        if (!term) return true;
        return [s.title, s.usernameOrEmail, s.url, s.notesForWifeAr].join(' ').toLowerCase().indexOf(term) >= 0;
      });
      if (!items.length) {
        container.appendChild(el('p', '', term ? 'لا توجد نتائج.' : 'لا توجد عناصر محفوظة بعد.'));
        return;
      }
      items.forEach(function (s) { container.appendChild(buildSecretCard(s, commanderView)); });
    }

    function buildSecretCard(s, commanderView) {
      const card = el('div', 'secret-card');
      const head = el('div', 'row');
      head.appendChild(el('strong', '', s.title));
      head.appendChild(el('span', '', CATEGORY_LABELS[s.category] || s.category));
      card.appendChild(head);

      if (s.usernameOrEmail) {
        const userRow = el('div', 'row');
        userRow.appendChild(el('span', 'value', s.usernameOrEmail));
        userRow.appendChild(copyButton(s.usernameOrEmail, 'نسخ'));
        card.appendChild(userRow);
      }

      if (s.category === 'critical_file') {
        card.appendChild(el('div', 'value', s.originalFilePath));
        card.appendChild(el('div', '', 'نسخ محفوظة: ' + s.versionsCount));
      } else {
        const valueRow = el('div', 'row');
        const valueSpan = el('span', 'value', '••••••••••');
        let shown = false;
        const toggle = el('button', 'mini-btn', 'إظهار');
        toggle.type = 'button';
        toggle.addEventListener('click', function () {
          shown = !shown;
          valueSpan.textContent = shown ? s.secretValue : '••••••••••';
          toggle.textContent = shown ? 'إخفاء' : 'إظهار';
        });
        valueRow.appendChild(valueSpan);
        const btns = el('span');
        btns.appendChild(toggle);
        btns.appendChild(copyButton(s.secretValue, 'نسخ السر'));
        valueRow.appendChild(btns);
        card.appendChild(valueRow);
      }

      if (s.url) card.appendChild(el('div', 'value', s.url));
      if (s.notesForWifeAr) card.appendChild(el('div', '', '💬 ' + s.notesForWifeAr));

      if (commanderView && vaultStatus.unlockedBy === 'commander' && s.category !== 'critical_file') {
        const actions = el('div', 'row');
        const del = el('button', 'mini-btn danger', 'حذف');
        del.type = 'button';
        del.addEventListener('click', function () { deleteSecret(s.id, s.title); });
        actions.appendChild(el('span', '', ''));
        actions.appendChild(del);
        card.appendChild(actions);
      }
      return card;
    }

    function copyButton(text, label) {
      const btn = el('button', 'mini-btn', label);
      btn.type = 'button';
      btn.addEventListener('click', async function () {
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = '✓ نُسخ';
          setTimeout(function () { btn.textContent = label; }, 1500);
          setTimeout(function () { navigator.clipboard.writeText('').catch(function () {}); }, 30000);
        } catch (e) {
          btn.textContent = 'تعذر النسخ';
        }
      });
      return btn;
    }

    async function setupVault() {
      const p1 = document.getElementById('setupPass').value;
      const p2 = document.getElementById('setupPass2').value;
      if (p1 !== p2) return showOutput('vaultOutputBox', '❌ تأكيد كلمة المرور غير مطابق.');
      try {
        const data = await api('/api/vault/setup', { body: { masterPassword: p1, confirmPassword: p2 } });
        document.getElementById('setupPass').value = '';
        document.getElementById('setupPass2').value = '';
        revealEmergencyKey(data.emergencyRecoveryKey, data.messageAr);
        await refreshVaultStatus();
      } catch (err) {
        showOutput('vaultOutputBox', '❌ ' + err.message);
      }
    }

    function revealEmergencyKey(key, message) {
      const box = document.getElementById('emergencyOutputBox');
      box.hidden = false;
      box.replaceChildren();
      box.appendChild(el('div', '', message));
      box.appendChild(el('div', 'key-reveal', key));
      document.getElementById('kitEmergencyKey').value = key;
    }

    async function unlockVaultUI(inputId) {
      playSciFiTone(400, 1200, 0.16);
      const input = document.getElementById(inputId);
      const key = input.value.trim();
      const outId = inputId === 'wifeEmergencyInput' ? 'wifeVaultStatus' : 'vaultOutputBox';
      if (!key) return showOutput(outId, 'يرجى إدخال كلمة المرور أو مفتاح الطوارئ أولاً.');
      try {
        await api('/api/vault/unlock', { body: { key: key } });
        input.value = '';
        document.getElementById('vaultOutputBox').hidden = true;
        await refreshVaultStatus();
      } catch (err) {
        showOutput(outId, '❌ ' + err.message);
      }
    }

    async function lockVaultUI() {
      try { await api('/api/vault/lock', { body: {} }); } catch (e) {}
      await refreshVaultStatus();
    }

    async function saveSecret() {
      playSciFiTone(480, 980, 0.12);
      const payload = {
        category: document.getElementById('secretCategory').value,
        title: document.getElementById('secretTitle').value,
        usernameOrEmail: document.getElementById('secretUser').value,
        secretValue: document.getElementById('secretVal').value,
        url: document.getElementById('secretUrl').value,
        notesForWifeAr: document.getElementById('secretWifeNote').value
      };
      try {
        const data = await api('/api/vault/secrets', { body: payload });
        ['secretTitle', 'secretUser', 'secretVal', 'secretUrl', 'secretWifeNote'].forEach(function (id) { document.getElementById(id).value = ''; });
        showOutput('vaultOutputBox', data.messageAr);
        await refreshVaultStatus();
      } catch (err) {
        showOutput('vaultOutputBox', '❌ ' + err.message);
      }
    }

    async function deleteSecret(id, title) {
      if (!confirm('حذف "' + title + '" من الخزنة نهائياً؟')) return;
      try {
        await api('/api/vault/secrets/delete', { body: { id: id } });
        await refreshVaultStatus();
      } catch (err) {
        showOutput('vaultOutputBox', '❌ ' + err.message);
      }
    }

    async function printEmergencyKit() {
      const key = document.getElementById('kitEmergencyKey').value.trim();
      if (!key) return showOutput('emergencyOutputBox', 'أدخل مفتاح الطوارئ أولاً.');
      const printWindow = window.open('', '_blank');
      try {
        const data = await api('/api/emergency/kit', { body: { emergencyKey: key } });
        if (printWindow) { printWindow.location.href = data.printUrl; } else { window.location.href = data.printUrl; }
        showOutput('emergencyOutputBox', '✅ فُتح كتيب الطوارئ في نافذة جديدة. اطبعه ثم أغلق النافذة (لا يُحفظ على القرص).');
      } catch (err) {
        if (printWindow) printWindow.close();
        showOutput('emergencyOutputBox', '❌ ' + err.message);
      }
    }

    async function createBackupUI() {
      showOutput('emergencyOutputBox', '⏳ جاري إنشاء النسخة الاحتياطية...');
      try {
        const data = await api('/api/emergency/backup', { body: {} });
        showOutput('emergencyOutputBox', data.messageAr + '\\n' + data.backupFilePath);
        loadBackupsList();
      } catch (err) {
        showOutput('emergencyOutputBox', '❌ ' + err.message);
      }
    }

    async function loadBackupsList() {
      let data;
      try { data = await api('/api/emergency/backups'); } catch (e) { return; }
      ['backupsListCommander', 'backupsListWife'].forEach(function (id) {
        const box = document.getElementById(id);
        if (!box) return;
        box.replaceChildren();
        box.appendChild(el('div', '', '📂 مجلد النسخ: ' + data.backupsDir));
        if (!data.backups.length) { box.appendChild(el('div', '', 'لا توجد نسخ احتياطية بعد.')); return; }
        data.backups.slice(0, 5).forEach(function (b) {
          const row = el('div', 'row');
          const name = el('span', 'value', b.fileName + ' (' + Math.round(b.sizeBytes / 1024) + ' KB)');
          row.appendChild(name);
          if (id === 'backupsListWife') {
            const pick = el('button', 'mini-btn', 'اختيار');
            pick.type = 'button';
            pick.addEventListener('click', function () { document.getElementById('restoreFile').value = b.filePath; });
            row.appendChild(pick);
          }
          box.appendChild(row);
        });
      });
    }

    async function changePasswordUI() {
      try {
        const data = await api('/api/vault/change-password', { body: {
          currentPassword: document.getElementById('cpCurrent').value,
          newPassword: document.getElementById('cpNew').value
        } });
        document.getElementById('cpCurrent').value = '';
        document.getElementById('cpNew').value = '';
        showOutput('emergencyOutputBox', '✅ ' + data.messageAr);
      } catch (err) {
        showOutput('emergencyOutputBox', '❌ ' + err.message);
      }
    }

    async function rotateKeyUI() {
      if (!confirm('سيُبطل هذا مفتاح الطوارئ المطبوع حالياً. متابعة؟')) return;
      try {
        const data = await api('/api/vault/rotate-emergency-key', { body: { masterPassword: document.getElementById('rotPass').value } });
        document.getElementById('rotPass').value = '';
        revealEmergencyKey(data.emergencyRecoveryKey, data.messageAr);
      } catch (err) {
        showOutput('emergencyOutputBox', '❌ ' + err.message);
      }
    }

    async function restoreBackupUI(dryRun) {
      const payload = {
        backupFile: document.getElementById('restoreFile').value.trim(),
        key: document.getElementById('restoreKey').value.trim(),
        targetDir: document.getElementById('restoreTarget').value.trim(),
        dryRun: dryRun
      };
      showOutput('restoreOutputBox', '⏳ جاري فتح النسخة الاحتياطية...');
      try {
        const data = await api('/api/emergency/restore', { body: payload });
        const head = dryRun
          ? '👁️ النسخة سليمة وتُفتح بهذا المفتاح. تاريخها: ' + data.createdAt + ' — عدد الملفات: ' + data.filesCount
          : '✅ تمت الاستعادة إلى: ' + data.targetDir + ' — عدد الملفات: ' + data.filesCount;
        showOutput('restoreOutputBox', head + '\\n' + data.files.slice(0, 15).join('\\n'));
      } catch (err) {
        showOutput('restoreOutputBox', '❌ ' + err.message);
      }
    }
  `;
}
