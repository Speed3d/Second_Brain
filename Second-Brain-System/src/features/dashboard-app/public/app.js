/* ============================================================================
 * الملف: src/features/dashboard-app/public/app.js
 * Hint بالعربي: منطق واجهة Second Brain في المتصفح:
 *   - التنقل بين الأقسام والوضعين (القائد / العائلة) مع حفظ التفضيلات محلياً.
 *   - المحادثة المتدفقة (SSE) مع سجل المحادثة، والصوت.
 *   - الخزنة: إنشاء، فتح، قفل، بطاقات مع إظهار/نسخ/تعديل/حذف، ومفاتيح الذكاء.
 *   - المشاريع، الذاكرة، الطوارئ والنسخ والاستعادة، والإعدادات.
 *   قواعد أمان: كل نص يُعرض عبر textContent فقط، والروابط http/https فقط، ولا أي كود مضمّن في الصفحة.
 * ============================================================================ */
'use strict';

(function () {
  // ===================== أدوات عامة =====================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const store = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem('sb.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem('sb.' + key, JSON.stringify(value));
      } catch (e) {
        /* التخزين المحلي غير متاح: نتجاهل */
      }
    },
  };

  const CATEGORY_LABELS = {
    email_account: '📧 بريد إلكتروني',
    password: '🔑 حساب',
    api_key: '🧩 مفتاح API',
    recovery_code: '🛟 أكواد استرداد',
    billing: '💳 فواتير',
    critical_file: '📁 ملف حساس',
    contact: '📞 جهة اتصال',
    family_instruction: '🧭 تعليمة للعائلة',
  };
  /** 3.1.0: عناصر بوابة العائلة لا تظهر في قوائم الأسرار (لها بطاقتها) */
  const PORTAL_CATEGORIES = ['contact', 'family_instruction'];
  const PROVIDER_NAMES = { 'claude-cli': 'Claude (اشتراكك)', claude: 'Claude API', gemini: 'Gemini API', ollama: 'Ollama', local: 'المعرفة المحلية' };
  const MASK = '••••••••••';

  const state = {
    app: null,
    projects: [],
    memories: [],
    memoryCount: 0,
    vault: { exists: false, unlocked: false, unlockedBy: null, secretsCount: null, secondsUntilAutoLock: null },
    secrets: [],
    settings: null,
    mode: 'commander',
    view: 'command',
    chat: { commander: [], family: [] },
    conversationId: { commander: null, family: null },
    conversationsMode: 'commander',
    unsavedWarned: { commander: false, family: false },
    lastAnswer: { commander: '', family: '' },
    busy: false,
    autoLockAt: null,
  };

  /** إنشاء عنصر مع نص آمن (textContent) وخصائص اختيارية */
  function el(tag, opts) {
    const node = document.createElement(tag);
    if (!opts) return node;
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
    if (opts.attrs) Object.keys(opts.attrs).forEach((k) => node.setAttribute(k, opts.attrs[k]));
    if (opts.children) opts.children.filter(Boolean).forEach((c) => node.appendChild(c));
    return node;
  }

  function button(label, className, onClick, attrs) {
    const b = el('button', { className: 'btn ' + (className || 'btn-ghost btn-sm'), text: label, attrs: Object.assign({ type: 'button' }, attrs || {}) });
    b.addEventListener('click', onClick);
    return b;
  }

  /** رابط آمن: يُنشأ فقط لعناوين http/https، وإلا يُعرض كنص */
  function safeLink(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return el('a', { text: url, attrs: { href: parsed.href, target: '_blank', rel: 'noopener noreferrer', dir: 'ltr' } });
      }
    } catch (e) {
      /* ليس رابطاً صالحاً */
    }
    return el('span', { className: 'mono', text: url });
  }

  function toast(text, kind, ms) {
    const box = $('#toasts');
    const t = el('div', { className: 'toast ' + (kind || ''), text: text, attrs: { role: kind === 'error' ? 'alert' : 'status' } });
    box.appendChild(t);
    setTimeout(() => t.remove(), ms || (kind === 'error' ? 8000 : 4500));
  }

  async function api(path, body) {
    const init = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* رد بلا JSON */
    }
    if (!res.ok) {
      const err = new Error(data.error || 'خطأ ' + res.status);
      err.status = res.status;
      err.data = data;
      if (res.status === 401 && data.locked) refreshVault();
      throw err;
    }
    return data;
  }

  /** تعطيل الزر أثناء تنفيذ عملية حتى لا تتكرر */
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } catch (err) {
      toast('❌ ' + err.message, 'error');
      return undefined;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function formData(form) {
    const out = {};
    $$('input, select, textarea', form).forEach((field) => {
      if (!field.name) return;
      out[field.name] = field.type === 'checkbox' ? field.checked : field.value;
    });
    return out;
  }

  function isCommander() {
    return state.vault.unlocked && state.vault.unlockedBy === 'commander';
  }

  const hologram = () => window.SBHologram || null;

  // ===================== الوضع والأقسام =====================
  function setMode(mode) {
    state.mode = mode;
    const family = mode === 'family';
    $('#commanderShell').hidden = family;
    $('#familyShell').hidden = !family;
    $$('.mode-btn').forEach((b) => {
      const active = b.dataset.mode === mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    updateHologramVisibility();
    if (family) loadBackups();
  }

  function setView(view) {
    if (!$('[data-panel="' + view + '"]')) view = 'command';
    if (state.view === 'settings' && view !== 'settings') lockSettings();
    state.view = view;
    if (view !== 'settings' && view !== 'project') store.set('view', view);
    $$('.view').forEach((p) => {
      const active = p.dataset.panel === view;
      p.hidden = !active;
      p.classList.toggle('is-active', active);
    });
    $$('.nav-btn').forEach((b) => {
      const active = b.dataset.view === view;
      b.classList.toggle('is-active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    updateHologramVisibility();
    if (view === 'vault' && state.vault.unlocked) loadSecrets();
    if (view === 'emergency') loadBackups();
    if (view === 'settings') requireSettingsAuth();
    if (view === 'connect') {
      loadProvidersGuide();
      loadMcpTools();
    }
    if (view === 'sync') loadSync();
    if (view === 'memory') loadKnowledge();
    if (view === 'knowledge') loadKnowledgeView();
  }

  // ===================== المزامنة (2.0: الكتابة من كل الأجهزة) =====================
  async function loadSync() {
    let s;
    try {
      s = await api('/api/sync/status');
    } catch (err) {
      return;
    }
    state.sync = s;
    renderSyncAlertBanner();
    if (!$('#syncFacts')) return;
    const badge = $('#syncModeBadge');
    if (!s.enabled) {
      badge.className = 'badge';
      badge.textContent = 'المزامنة مطفأة';
    } else if (!s.ready) {
      badge.className = 'badge warn';
      badge.textContent = '⚠️ غير جاهزة';
    } else if (!s.migrated) {
      badge.className = 'badge warn';
      badge.textContent = '⏳ بانتظار الترحيل (افتح الخزنة)';
    } else {
      badge.className = 'badge ok';
      badge.textContent = '✍️ الكتابة من كل الأجهزة';
    }
    $('#syncDeviceTitle').textContent = s.device ? 'هذا الجهاز: ' + s.device.deviceName : 'هذا الجهاز';
    const fmt = (iso) => (iso ? formatDateAr(iso) : '—');
    const facts = [
      ['مجلد المزامنة', s.folder || '—'],
      ['آخر نشر من هذا الجهاز', fmt(s.lastPublishAt)],
      ['آخر دمج من الأجهزة الأخرى', fmt(s.lastMergeAt)],
      ['تعارضات مفتوحة', s.ready ? String(s.conflicts || 0) : '—'],
      ['في السلة', s.ready ? String(s.trash || 0) : '—'],
    ];
    if (s.lastWarning) facts.push(['تنبيه', s.lastWarning]);
    if (s.lastError) facts.push(['آخر خطأ', s.lastError]);
    $('#syncFacts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
    const problem = $('#syncProblem');
    problem.hidden = !s.problemAr;
    problem.textContent = s.problemAr || '';
    $('[data-action="sync-now"]').hidden = !s.ready;

    const devices = (s.devices || []).filter((d) => d.deviceId !== 'second-brain-2-multi-writer');
    showWhen($('#syncDevicesCard'), devices.length > 0);
    $('#syncDevicesList').replaceChildren(
      ...devices.map((d) =>
        el('li', {
          children: [
            el('strong', { text: (d.isThisDevice ? '📍 ' : '') + d.deviceName }),
            el('span', { className: 'muted small', text: ' — آخر ظهور ' + fmt(d.lastSeenAt) + (d.appVersion ? ' · الإصدار ' + d.appVersion : '') + (d.syncFormat === 2 ? '' : ' · ⚠️ إصدار قديم: حدّثه إلى 2.0') }),
          ],
        })
      )
    );
    $('#syncTrashCount').textContent = s.ready ? String(s.trash || 0) : '';
    const trashCard = $('#syncTrashCard');
    if (trashCard && !trashCard.dataset.bound) {
      trashCard.addEventListener('toggle', () => {
        if (trashCard.open) loadSyncTrash();
      });
      trashCard.dataset.bound = '1';
    }
    await loadSyncConflicts(s);
    await loadSyncHeld(s);

    const form = $('[data-form="sync-settings"]');
    if (form && !form.dataset.filled) {
      form.elements.enabled.checked = Boolean(s.enabled);
      form.elements.folder.value = s.folder || (s.suggestedFolders && s.suggestedFolders[0]) || '';
      form.dataset.filled = '1';
    }
    $('#syncFolderSuggestions').replaceChildren(...(s.suggestedFolders || []).map((f) => el('option', { attrs: { value: f } })));
  }

  async function loadSyncConflicts(s) {
    const card = $('#syncConflictsCard');
    if (!card) return;
    const count = s && s.ready ? s.conflicts || 0 : 0;
    showWhen(card, count > 0);
    if (!count) return;
    let r;
    try {
      r = await api('/api/sync/conflicts');
    } catch (err) {
      return;
    }
    $('#syncConflictsCount').textContent = String(r.conflicts.length);
    const kindAr = { edit: 'تعديلان مختلفان', secret: 'سرّ عُدّل على جهازين', 'delete-vs-edit': 'حُذف على جهاز وعُدّل على آخر' };
    $('#syncConflictsList').replaceChildren(
      ...r.conflicts.map((c) => {
        const pane = (title, p) => el('div', { className: 'conflict-pane', children: [el('h3', { className: 'small', text: title }), el('pre', { className: 'mono small', text: p ? p.text : '(محذوف)', attrs: { dir: 'auto' } })] });
        const keptTitle = 'المعتمدة الآن' + (c.keptSide === 'incoming' ? ' (من ' + c.otherDevice + ')' : ' (هذا الجهاز)');
        const otherTitle = 'الأخرى' + (c.keptSide === 'incoming' ? ' (هذا الجهاز)' : ' (من ' + c.otherDevice + ')');
        return el('article', {
          className: 'card conflict',
          children: [
            el('p', { className: 'small', children: [el('strong', { text: syncRecordLabel(c.key) }), el('bdi', { className: 'mono', text: syncRecordPath(c.key), attrs: { dir: 'ltr' } }), el('span', { className: 'muted', text: ' — ' + (kindAr[c.kind] || c.kind) + ' · ' + formatDateAr(c.createdAt) })] }),
            c.sideFile ? el('p', { className: 'small muted', children: [el('span', { text: 'كُتبت النسخة الأخرى بجانب الملف باسم: ' }), el('bdi', { className: 'mono', text: c.sideFile.slice(4), attrs: { dir: 'ltr' } })] }) : null,
            el('div', { className: 'conflict-grid', children: [pane(keptTitle, c.current), pane(otherTitle, c.other)] }),
            el('div', {
              className: 'card-actions',
              children: [
                el('button', { className: 'btn btn-primary btn-sm', text: '✅ أبقِ المعتمدة الآن', attrs: { type: 'button', 'data-action': 'sync-resolve', 'data-id': c.id, 'data-choice': 'keep' } }),
                el('button', { className: 'btn btn-ghost btn-sm', text: '↔️ اعتمد الأخرى', attrs: { type: 'button', 'data-action': 'sync-resolve', 'data-id': c.id, 'data-choice': 'other' } }),
              ],
            }),
          ],
        });
      })
    );
  }

  /** اسم مفهوم لنوع السجل في المزامنة */
  function syncRecordLabel(key) {
    const kind = key.split(':')[0];
    return ({ obs: '📄 ملف Obsidian: ', secret: '🔑 سرّ في الخزنة ', memory: '🧠 سجل ذاكرة ', project: '📁 مشروع ', conv: '💬 محادثة ', flog: '📝 سجل الطوارئ ', branding: '🪪 الهوية', vaultkeys: '🔐 مفاتيح الخزنة' })[kind] || key;
  }

  function syncRecordPath(key) {
    const kind = key.split(':')[0];
    return kind === 'obs' || kind === 'project' || kind === 'memory' ? key.slice(kind.length + 1) : '';
  }

  /** ISS-028: الحذف الجماعي المعلّق */
  async function loadSyncHeld(s) {
    const card = $('#syncHeldCard');
    if (!card) return;
    const any = s && s.ready && ((s.heldOutgoing || 0) > 0 || s.heldIncoming);
    showWhen(card, Boolean(any));
    if (!any) return;
    let r;
    try {
      r = await api('/api/sync/held');
    } catch (err) {
      return;
    }
    const block = (title, item, direction, confirmLabel, rejectLabel) =>
      el('div', {
        className: 'report',
        children: [
          el('p', { className: 'small', children: [el('strong', { text: title }), el('span', { className: 'muted', text: ' — ' + item.reasonAr + ' · ' + formatDateAr(item.detectedAt) })] }),
          el('ul', { className: 'list compact', children: item.sample.map((k) => el('li', { children: [el('bdi', { className: 'mono small', text: k, attrs: { dir: 'auto' } })] })).concat(item.count > item.sample.length ? [el('li', { className: 'muted small', text: '… و' + (item.count - item.sample.length) + ' غيرها' })] : []) }),
          el('div', {
            className: 'card-actions',
            children: [
              el('button', { className: 'btn btn-danger btn-sm', text: confirmLabel, attrs: { type: 'button', 'data-action': 'sync-held', 'data-direction': direction, 'data-choice': 'confirm' } }),
              el('button', { className: 'btn btn-primary btn-sm', text: rejectLabel, attrs: { type: 'button', 'data-action': 'sync-held', 'data-direction': direction, 'data-choice': 'reject' } }),
            ],
          }),
        ],
      });
    const parts = [];
    if (r.outgoing) parts.push(block('من هذا الجهاز: ' + r.outgoing.count + ' عنصراً اختفت', r.outgoing, 'outgoing', '🗑️ نعم، حذفتها: احذفها من كل الأجهزة', '♻️ لا، أعدها هنا'));
    r.incoming.forEach((h) => parts.push(block('من «' + h.deviceName + '»: حذف ' + h.count + ' عنصراً', h, 'incoming', '🗑️ طبّق الحذف هنا أيضاً', '♻️ لا، أبقها وأعدها للجهاز الآخر')));
    $('#syncHeldList').replaceChildren(...parts);
  }

  async function loadSyncTrash() {
    let r;
    try {
      r = await api('/api/sync/trash');
    } catch (err) {
      return;
    }
    const list = $('#syncTrashList');
    if (!r.items.length) {
      list.replaceChildren(el('li', { className: 'muted small', text: 'السلة فارغة.' }));
      return;
    }
    list.replaceChildren(
      ...r.items.map((t) =>
        el('li', {
          children: [
            el('span', { text: t.label }),
            el('span', { className: 'muted small', text: ' — حُذف ' + formatDateAr(t.deletedAt) + ' (' + t.deletedBy + ') ' }),
            el('button', { className: 'btn btn-ghost btn-sm', text: '♻️ استرجع', attrs: { type: 'button', 'data-action': 'sync-restore', 'data-id': t.id } }),
          ],
        })
      )
    );
  }

  function renderSyncAlertBanner() {
    const s = state.sync;
    const banner = $('#syncAlertBanner');
    if (!banner) return;
    const n = s && s.ready ? s.conflicts || 0 : 0;
    const held = s && s.ready && ((s.heldOutgoing || 0) > 0 || s.heldIncoming);
    banner.hidden = !n && !held;
    if (held) $('#syncAlertText').textContent = '🛑 حذف جماعي في المزامنة ينتظر تأكيدك (لم يُحذف شيء من الأجهزة الأخرى بعد).';
    else if (n) $('#syncAlertText').textContent = '⚠️ ' + n + ' تعارض في المزامنة ينتظر قرارك (عُدّل الشيء نفسه على جهازين).';
  }

  // ===================== ISS-032: الكود على القرص أحدث من الذي يعمل =====================
  async function checkRuntimeVersion() {
    let h;
    try {
      h = await (await fetch('/api/health', { credentials: 'same-origin' })).json();
    } catch (err) {
      return null;
    }
    const banner = $('#restartBanner');
    if (banner) {
      banner.hidden = !h.restartRequired;
      if (h.restartRequired) {
        $('#restartText').textContent = '⏸️ حُدّث البرنامج على القرص إلى ' + h.diskVersion + '، والخادم ما زال يعمل بالإصدار ' + h.version + '. المزامنة متوقفة حتى تعيد تشغيل الخادم.';
      }
    }
    // 3.9.3 (ISS-046): مجلد البرنامج قابل للتعديل من حسابات أخرى
    const perm = $('#permBanner');
    if (perm) {
      perm.hidden = !(h.folderPermissions && h.folderPermissions.open);
      if (!perm.hidden) $('#permText').textContent = h.folderPermissions.detailAr;
    }
    return h;
  }

  async function restartServer(btn) {
    if (!window.confirm('سيُعاد تشغيل الخادم بالإصدار الجديد، وتُقفل الخزنة (تفتحها من جديد بعد ثوانٍ). متابعة؟')) return;
    const r = await busy(btn, () => api('/api/system/restart', {}));
    if (!r) return;
    toast(r.messageAr, 'ok', 8000);
    // ننتظر عودة الخادم بالكود الجديد ثم نعيد تحميل الصفحة
    for (let i = 0; i < 30; i += 1) {
      await new Promise((res) => setTimeout(res, 1500));
      const h = await checkRuntimeVersion();
      if (h && !h.restartRequired && h.startedAt !== r.startedAt) {
        location.reload();
        return;
      }
    }
    toast('لم يعد الخادم خلال 45 ثانية. إن كان يعمل يدوياً (لا من الاختصار) فشغّله من جديد.', 'error', 12000);
  }

  async function syncAction(btn, pathName, body) {
    const r = await busy(btn, () => api(pathName, body || {}));
    if (!r) return;
    toast(r.messageAr, 'ok', 7000);
    state.sync = null;
    await loadSync();
    await loadState();
  }

  // ===================== حماية الإعدادات بكلمة المرور =====================
  /** كل دخول لقسم الإعدادات يطلب كلمة المرور الرئيسية من جديد */
  function requireSettingsAuth() {
    $('#devPanel').hidden = true;
    $('[data-form="settings"]').hidden = true;
    $('#settingsLocked').hidden = false;
    if (!state.vault.exists) {
      loadSettings(); // قبل إنشاء الخزنة (أول تشغيل) لا توجد كلمة مرور بعد
      return;
    }
    openSettingsAuth();
  }

  function openSettingsAuth() {
    const dialog = $('#authDialog');
    $('[data-form="settings-auth"]').reset();
    $('#settingsTwoFactorField').hidden = true;
    if (!dialog.open) dialog.showModal();
    $('[data-form="settings-auth"]').elements.password.focus();
  }

  function lockSettings() {
    $('#devPanel').hidden = true;
    $('[data-form="settings"]').hidden = true;
    $('#settingsLocked').hidden = false;
    api('/api/settings/lock', {}).catch(() => {});
  }

  function updateHologramVisibility() {
    const h = hologram();
    if (h) h.setVisible(state.mode === 'commander' && state.view === 'command' && !document.hidden);
  }

  // ===================== البيانات العامة =====================
  async function loadState() {
    try {
      const data = await api('/api/state');
      state.app = data.app;
      state.locked = data.locked === true;
      renderAutoSpeakToggles();
      state.projects = data.projects;
      state.memories = data.memories;
      state.memoryCount = data.memoryCount;
      renderBrand();
      renderProjects();
      renderFamilyProjects();
      renderMemory();
    } catch (err) {
      toast('تعذر تحميل البيانات: ' + err.message, 'error');
    }
  }

  function renderBrand() {
    const app = state.app;
    if (!app) return;
    document.title = app.appName;
    $('#brandName').textContent = app.appName;
    $('#brandSubtitle').textContent = app.appTitleAr;
    $('#versionLabel').textContent = 'v' + app.version;
    $('#chatTitle').textContent = 'المحادثة مع ' + app.assistantNameAr;
    $('#familyTitle').textContent = 'أهلاً بكِ يا ' + app.familyMemberTitle;
    $('#chipProjects').textContent = String(state.projects.length);
    $('#chipMemory').textContent = String(state.memoryCount);
  }

  // ===================== المشاريع =====================
  function renderProjects() {
    const list = $('#projectsList');
    list.replaceChildren();
    if (state.locked) {
      list.appendChild(el('div', { className: 'empty-state', text: '🔒 افتح الخزنة لعرض المشاريع (بياناتها لا تُعرض والخزنة مقفلة).' }));
      return;
    }
    if (!state.projects.length) {
      list.appendChild(el('div', { className: 'empty-state', text: 'لا توجد مشاريع بعد. اضغط "مشروع جديد" لإضافة أول مشروع.' }));
      return;
    }
    state.projects.forEach((p) => {
      const tags = el('div', { className: 'tags' });
      p.stack.forEach((s) => tags.appendChild(el('span', { className: 'badge', text: s })));
      if (p.gitBranch) tags.appendChild(el('span', { className: 'badge', text: '🌿 ' + p.gitBranch }));
      const total = p.criticalFiles.length;
      if (total) tags.appendChild(el('span', { className: 'badge ' + (p.securedCount === total ? 'ok' : 'warn'), text: '🔐 ' + p.securedCount + '/' + total + ' مؤمَّن' }));
      if (p.trackedByGit.length) tags.appendChild(el('span', { className: 'badge danger', text: '⚠️ ملف حساس على Git' }));

      const card = el('article', {
        className: 'card project-card',
        children: [
          el('h3', { text: p.name }),
          el('div', { className: 'path', text: p.path }),
          tags,
          p.descriptionAr ? el('p', { className: 'small', text: p.descriptionAr }) : null,
          p.runCommand ? el('p', { className: 'small', children: [el('span', { className: 'muted', text: '▶️ التشغيل: ' }), el('code', { text: p.runCommand })] }) : null,
          p.lastCommitMessage
            ? el('p', { className: 'small muted', text: '🕒 آخر commit: ' + p.lastCommitMessage + (p.uncommittedChanges ? ' — ' + p.uncommittedChanges + ' تغيير غير محفوظ' : '') })
            : null,
          p.trackedByGit.length ? el('p', { className: 'small', text: '⚠️ مرفوع على Git: ' + p.trackedByGit.join('، ') + ' — احذفه من المستودع وغيّر أي سر بداخله.' }) : null,
          el('p', { className: 'small muted', text: 'اضغط لفتح صفحة المشروع ←' }),
        ],
      });
      card.classList.add('is-clickable');
      card.tabIndex = 0;
      card.setAttribute('role', 'link');
      card.setAttribute('aria-label', 'فتح صفحة المشروع ' + p.name);
      card.addEventListener('click', () => openProject(p.id));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openProject(p.id);
        }
      });
      list.appendChild(card);
    });
  }

  // ===================== صفحة المشروع =====================
  function projectSection(title, children) {
    return el('section', { className: 'card project-section', children: [el('h2', { text: title })].concat(children) });
  }

  function commandRows(list) {
    if (!list || !list.length) return [el('p', { className: 'small muted', text: '—' })];
    return list.map((c) => el('div', { className: 'cmd-row', children: [el('code', { text: c }), copyButton(c, '📋 نسخ')] }));
  }

  function plainList(items, render, emptyText) {
    if (!items.length) return el('p', { className: 'small muted', text: emptyText });
    const ul = el('ul', { className: 'plain-list' });
    items.forEach((it) => ul.appendChild(render(it)));
    return ul;
  }

  async function openProject(id) {
    state.projectId = id;
    setView('project');
    $('#h-project').textContent = 'جارٍ التحميل…';
    $('#projectPath').textContent = '';
    $('#projectBody').replaceChildren();
    try {
      state.projectDetails = await api('/api/projects/' + encodeURIComponent(id));
      renderProjectPage();
    } catch (err) {
      toast('❌ ' + err.message, 'error');
      setView('projects');
    }
  }

  function renderProjectPage() {
    const d = state.projectDetails;
    if (!d) return;
    const p = d.project;
    const r = d.report;
    $('#h-project').textContent = p.name;
    $('#projectPath').textContent = p.path + (p.pathExists ? '' : '  (غير موجود على هذا الجهاز)');
    const commander = isCommander();
    $$('#projectToolbar [data-action="project-open"], #projectToolbar [data-action="project-edit"], #projectToolbar [data-action="project-remove"]').forEach((b) => {
      b.disabled = !commander;
      b.title = commander ? '' : 'افتح الخزنة بكلمة المرور الرئيسية أولاً';
    });

    const tags = el('div', { className: 'tags' });
    r.stack.forEach((s) => tags.appendChild(el('span', { className: 'badge', text: s })));
    const total = r.criticalFiles.length;
    if (total) tags.appendChild(el('span', { className: 'badge ' + (r.securedCount === total ? 'ok' : 'warn'), text: '🔐 ' + r.securedCount + '/' + total + ' مؤمَّن' }));

    const summaryBox = p.summaryAr
      ? el('div', { className: 'project-summary', text: p.summaryAr })
      : el('p', { className: 'small muted', text: 'لا توجد خلاصة بعد. اضغط "توليد بالذكاء" ليكتبها المساعد من ملفات المشروع، أو "تعديل" لكتابتها بنفسك.' });
    const genBtn = button('✨ توليد بالذكاء', 'btn-primary btn-sm', (e) => generateSummary(e.currentTarget));
    genBtn.disabled = state.vault.exists && !commander;

    const git = r.gitBranch
      ? [
          el('p', { className: 'small', text: '🌿 الفرع: ' + r.gitBranch }),
          r.lastCommitMessage ? el('p', { className: 'small', text: '🕒 آخر commit: ' + r.lastCommitMessage + (r.lastCommitDate ? ' — ' + String(r.lastCommitDate).slice(0, 10) : '') }) : null,
          el('p', { className: 'small ' + (r.uncommittedChanges ? '' : 'muted'), text: r.uncommittedChanges ? '✏️ ' + r.uncommittedChanges + ' تغيير غير محفوظ' : 'لا تغييرات غير محفوظة.' }),
          r.trackedByGit.length ? el('p', { className: 'small', text: '⚠️ ملفات حساسة مرفوعة على Git: ' + r.trackedByGit.join('، ') }) : null,
        ]
      : [el('p', { className: 'small muted', text: 'المشروع ليس مستودع Git.' })];

    const decisionBox = el('div', { className: 'stack', children: [el('p', { className: 'small muted', text: '⏳ جارٍ تحميل سجل القرارات…' })] });
    if (commander) loadDecisionLog(p.id, decisionBox);

    $('#projectBody').replaceChildren(
      projectSection('📌 ما هو؟', [
        tags,
        el('p', { text: p.descriptionAr || '—' }),
        el('p', { className: 'small', children: [el('strong', { text: 'للعائلة: ' }), el('span', { text: p.wifeSummaryAr || '—' })] }),
        el('p', { className: 'small', children: [el('strong', { text: '💰 الدخل: ' }), el('span', { text: p.monthlyIncome || '—' }), el('strong', { text: '  🧾 الفواتير: ' }), el('span', { text: p.billingNotes || '—' })] }),
      ]),
      projectSection('🧭 الخلاصة: ماذا يخدم وكيف يعمل', [summaryBox, el('div', { className: 'card-actions', children: [genBtn] })]),
      ...(commander ? [projectSection('📤 المعرفة في Obsidian', [knowledgeExportToggle(p)])] : []),
      el('div', {
        className: 'card-grid two',
        children: [
          projectSection('▶️ أوامر التشغيل', commandRows(r.runCommands).concat(r.buildCommands.length ? [el('h2', { text: '🏗️ البناء' })].concat(commandRows(r.buildCommands)) : [])),
          projectSection('🌿 Git', git),
        ],
      }),
      projectSection('🔐 الملفات الحساسة', [
        plainList(r.criticalFiles, (c) => el('li', { children: [el('span', { className: 'mono', text: c.path }), el('div', { className: 'muted', text: c.reasonAr + ' — ' + c.stateAr })] }), 'لم تُكتشف ملفات حساسة.'),
      ]),
      projectSection('📜 آخر التغييرات', [plainList(d.changelog, (c) => el('li', { text: c }), 'لا يوجد سجل تغييرات بعد.')]),
      ...(commander ? [projectSection('🗳️ سجل القرارات', [decisionBox])] : []),
      projectSection('🧠 القرارات والذاكرة', [
        plainList(
          d.memories,
          (m) => el('li', { children: [el('strong', { text: m.title }), el('div', { className: 'muted small', text: m.createdAt.slice(0, 10) + ' — ' + m.sourceAI }), el('div', { text: m.summaryAr })] }),
          'لا توجد سجلات ذاكرة لهذا المشروع.'
        ),
      ]),
      projectSection('💬 المحادثات المؤرشفة', [
        plainList(
          d.conversations,
          (c) => {
            const readBtn = button('📖 قراءة', 'btn-ghost btn-sm', () => readConversation(c));
            readBtn.disabled = !commander;
            return el('li', {
              children: [
                el('strong', { text: c.title }),
                el('div', { className: 'muted small', text: c.modifiedAt.slice(0, 16).replace('T', ' ') + ' — ' + Math.ceil(c.sizeBytes / 1024) + ' KB' }),
                el('div', { className: 'card-actions', children: [readBtn] }),
              ],
            });
          },
          'لا توجد محادثات مؤرشفة. اجمعها من قسم "الذاكرة".'
        ),
      ]),
      el('p', { className: 'small muted', text: 'آخر فحص: ' + String(r.scannedAt).slice(0, 16).replace('T', ' ') })
    );
  }

  // 4.0.3: تصدير معرفة المشروع غير الحساسة إلى Obsidian (05-Knowledge)، معطّل افتراضياً
  function knowledgeExportToggle(p) {
    const input = el('input', { attrs: Object.assign({ type: 'checkbox' }, p.knowledgeExport ? { checked: 'checked' } : {}) });
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        const d = await api('/api/knowledge/export', { projectId: p.id, enabled: input.checked });
        p.knowledgeExport = input.checked;
        toast(d.messageAr, 'ok', 8000);
      } catch (err) {
        input.checked = !input.checked;
        toast('❌ ' + err.message, 'error');
      } finally {
        input.disabled = false;
      }
    });
    return el('label', {
      className: 'check',
      children: [
        input,
        el('span', {
          children: [
            el('strong', { text: 'صدّر معرفة هذا المشروع إلى Obsidian' }),
            el('span', { className: 'muted small block', text: 'ملاحظة لكل قرار وحقيقة ومهمة في 05-Knowledge، بروابط تعمل في مخطط Obsidian. الأشخاص والعقود والفواتير لا تُصدَّر أبداً. ⚠️ ملفات Obsidian نص غير مشفّر على القرص.' }),
          ],
        }),
      ],
    });
  }

  async function generateSummary(btn) {
    btn.textContent = '⏳ يكتب المساعد…';
    await busy(btn, async () => {
      const data = await api('/api/projects/' + encodeURIComponent(state.projectId) + '/summary', {});
      toast('✅ كُتبت الخلاصة بواسطة ' + (PROVIDER_NAMES[data.providerUsed] || data.providerUsed), 'ok');
      await openProject(state.projectId);
    });
    btn.textContent = '✨ توليد بالذكاء';
  }

  async function readConversation(c) {
    try {
      const data = await api('/api/projects/' + encodeURIComponent(state.projectId) + '/conversations/' + encodeURIComponent(c.file));
      $('#conversationDialogTitle').textContent = c.title;
      $('#conversationText').textContent = data.content;
      $('#conversationDialog').showModal();
    } catch (err) {
      toast('❌ ' + err.message, 'error');
    }
  }

  function openProjectDialog() {
    const p = state.projectDetails && state.projectDetails.project;
    if (!p) return;
    const f = $('[data-form="project-edit"]');
    ['descriptionAr', 'wifeSummaryAr', 'monthlyIncome', 'billingNotes', 'summaryAr'].forEach((k) => (f.elements[k].value = p[k] || ''));
    $('#projectDialog').showModal();
  }

  function renderFamilyProjects() {
    const box = $('#familyProjects');
    box.replaceChildren();
    if (state.locked) {
      box.appendChild(el('p', { text: '🔒 افتحي الخزنة بمفتاح الطوارئ (الخطوة 1)، فتظهر هنا المشاريع والدخل والفواتير.' }));
      return;
    }
    if (!state.projects.length) {
      box.appendChild(el('p', { text: 'لا توجد مشاريع مسجلة بعد.' }));
      return;
    }
    state.projects.forEach((p) => {
      box.appendChild(
        el('article', {
          className: 'card',
          children: [
            el('h3', { text: '📱 ' + p.name }),
            el('p', { children: [el('strong', { text: 'ما هو؟ ' }), el('span', { text: p.wifeSummaryAr || '—' })] }),
            el('p', { children: [el('strong', { text: '💰 الدخل: ' }), el('span', { text: p.monthlyIncome || '—' })] }),
            el('p', { children: [el('strong', { text: '🧾 الفواتير: ' }), el('span', { text: p.billingNotes || '—' })] }),
          ],
        })
      );
    });
  }

  function showReport(id, text) {
    const box = $(id);
    box.hidden = false;
    box.textContent = text;
  }

  async function rescan(btn) {
    await busy(btn, async () => {
      const data = await api('/api/projects/rescan', {});
      const lines = data.projects.map((p) => {
        let line = '• ' + p.name + ': ملفات حساسة ' + p.critical + '، مؤمَّن منها ' + p.secured;
        if (p.error) line += '\n   ❌ ' + p.error;
        if (p.trackedByGit && p.trackedByGit.length) line += '\n   ⚠️ مرفوع على Git: ' + p.trackedByGit.join('، ');
        if (p.changes && p.changes.length) line += '\n   ' + p.changes.join('\n   ');
        else line += '\n   لا تغيير منذ آخر فحص.';
        return line;
      });
      showReport('#projectsReport', '✅ اكتمل الفحص وتحديث Obsidian.\n' + lines.join('\n') + (data.vaultUnlocked ? '' : '\n(الخزنة مقفلة: افتحها ثم أعد الفحص لتأمين الملفات الحساسة)'));
      await loadState();
    });
  }

  // ===================== الخزنة =====================
  async function refreshVault() {
    const before = state.vault.unlocked ? state.vault.unlockedBy : null;
    try {
      state.vault = await api('/api/vault/status');
    } catch (e) {
      return;
    }
    // 3.9.10 (ISS-053): بيانات المشاريع والذاكرة تتبع الجلسة، فتُعاد قراءتها عند الفتح والقفل
    const after = state.vault.unlocked ? state.vault.unlockedBy : null;
    if (before !== after) {
      loadState();
      if (state.view === 'knowledge') loadKnowledgeView();
    }
    state.autoLockAt = state.vault.unlocked ? Date.now() + (state.vault.secondsUntilAutoLock || 0) * 1000 : null;
    renderVaultChrome();
    if (state.vault.unlocked) await loadSecrets();
    else {
      state.secrets = [];
      renderSecrets();
    }
    await loadFamilyVault();
    await loadPortal();
    await loadProbeReports();
    await loadPasskeys();
    await loadTwoFactor();
  }

  // ===================== 3.5.0: المصادقة الثنائية =====================
  async function loadTwoFactor() {
    const card = $('#twoFactorCard');
    if (!card || !isCommander()) return;
    let st;
    try {
      st = await api('/api/2fa/status');
    } catch (e) {
      return;
    }
    $('#twoFactorStatus').textContent = st.enabled
      ? '✅ مفعّلة منذ ' + formatDateAr(st.enabledAt) + '. الرموز الاحتياطية الباقية: ' + st.backupLeft + ' من 10.' + (st.backupLeft <= 3 ? ' ⚠️ أنشئ رموزاً جديدة.' : '')
      : '⚪ غير مفعّلة.';
    $('#twoFactorBegin').hidden = st.enabled || !$('#twoFactorSetup').hidden;
    $('#twoFactorManage').hidden = !st.enabled;
    if (st.enabled) $('#twoFactorSetup').hidden = true;
  }

  function showBackupCodes(data) {
    const box = $('#twoFactorCodes');
    box.hidden = false;
    box.replaceChildren(
      el('p', { children: [el('strong', { text: '🔑 الرموز الاحتياطية (تُعرض مرة واحدة):' })] }),
      el('p', { className: 'mono', text: data.codes.join('   '), attrs: { dir: 'ltr' } }),
      el('p', { children: [button('🖨️ افتح ورقة الطباعة', 'btn-primary btn-sm', () => window.open(data.printUrl, '_blank', 'noopener'))] }),
      el('p', { className: 'small muted', text: 'ورقة الطباعة تُفتح مرة واحدة خلال دقيقتين. احفظها منفصلة عن كتيب العائلة وعن كلمة المرور.' })
    );
  }

  // ===================== 3.3.0: الدخول بالبصمة أو رمز الجهاز (Passkeys بامتداد PRF) =====================
  function b64uToBytes(s) {
    const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
    const out = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }

  function bytesToB64u(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** زر الفتح يظهر فقط على localhost، والخزنة مقفلة، ويوجد Passkey صالح على هذا الجهاز */
  async function loadPasskeys() {
    const btn = $('#passkeyUnlockBtn');
    let count = 0;
    try {
      count = (await api('/api/passkeys/status')).count;
    } catch (e) {
      count = 0;
    }
    if (btn) btn.hidden = !(count > 0 && probeHostOk() && state.vault.exists && !state.vault.unlocked && window.PublicKeyCredential);
    const list = $('#passkeysList');
    if (!list || !isCommander()) return;
    const warn = $('#passkeyHostWarn');
    const okHost = probeHostOk();
    warn.hidden = okHost;
    $('[data-form="passkey-register"] button[type="submit"]').disabled = !okHost;
    if (!okHost) warn.replaceChildren(el('span', { text: '⚠️ Passkeys لا تعمل على العنوان ' + location.host + '. افتح البرنامج على ' }), safeLink('http://localhost:' + location.port + '/'));
    let r;
    try {
      r = await api('/api/passkeys');
    } catch (e) {
      return;
    }
    list.replaceChildren(
      ...(r.passkeys.length
        ? r.passkeys.map((p) =>
            el('div', {
              className: 'list-item small',
              children: [
                el('strong', { text: '👆 ' + p.label }),
                el('span', { className: 'muted', text: ' · سُجّل ' + formatDateAr(p.createdAt) + (p.lastUsedAt ? ' · آخر استخدام ' + formatDateAr(p.lastUsedAt) : ' · لم يُستخدم بعد') + (p.backupEligible ? ' · مُزامَن في مدير كلمات المرور' : '') }),
                button('🗑️ إلغاء', 'btn-ghost btn-sm', () => deletePasskey(p)),
              ],
            })
          )
        : [el('p', { className: 'muted small', text: 'لا Passkey مسجّل على هذا الجهاز بعد.' })])
    );
  }

  async function deletePasskey(p) {
    if (!window.confirm('إلغاء «' + p.label + '» على هذا الجهاز؟ لن يفتح الخزنة بعد الآن.')) return;
    await busy(null, async () => {
      const data = await api('/api/passkeys/delete', { credentialId: p.credentialId });
      toast(data.messageAr, 'ok', 9000);
      await loadPasskeys();
    });
  }

  function prfFirst(credential) {
    const e = credential.getClientExtensionResults() || {};
    return e.prf && e.prf.results && e.prf.results.first ? new Uint8Array(e.prf.results.first) : null;
  }

  async function passkeyUnlock(btn) {
    await busy(btn, async () => {
      const opt = await api('/api/passkeys/unlock/begin', {});
      const evalByCredential = {};
      opt.credentials.forEach((c) => (evalByCredential[c.id] = { first: b64uToBytes(c.prfSalt) }));
      let a;
      try {
        a = await navigator.credentials.get({
          publicKey: {
            challenge: b64uToBytes(opt.challenge),
            rpId: opt.rpId,
            allowCredentials: opt.credentials.map((c) => ({ type: 'public-key', id: b64uToBytes(c.id) })),
            userVerification: 'required',
            timeout: 120000,
            extensions: { prf: { evalByCredential: evalByCredential } },
          },
        });
      } catch (err) {
        throw new Error(err && err.name === 'NotAllowedError' ? 'أُلغي الطلب أو انتهى وقته.' : 'تعذّر استخدام الـ Passkey: ' + ((err && err.name) || ''));
      }
      const first = prfFirst(a);
      if (!first) throw new Error('هذا الـ Passkey لم يُعطِ سرّ PRF، فلا يفتح الخزنة. افتح بكلمة المرور.');
      const r = await api('/api/passkeys/unlock/finish', {
        challenge: opt.challenge,
        credentialId: bytesToB64u(a.rawId),
        authenticatorData: bytesToB64u(a.response.authenticatorData),
        clientDataJSON: bytesToB64u(a.response.clientDataJSON),
        signature: bytesToB64u(a.response.signature),
        prfOutput: bytesToB64u(first),
      });
      first.fill(0);
      await refreshVault();
      refreshProviders();
      toast('🔓 فُتحت الخزنة بالـ Passkey.', 'ok');
      if (r.syncMessageAr) {
        toast(r.syncMessageAr, 'ok', 9000);
        await loadState();
      }
      loadSync();
    });
  }

  /**
   * 3.1.0: بوابة العائلة: بطاقة القائد (جهات الاتصال والتعليمات والسجل) وخطوات وضع العائلة
   */
  async function loadPortal() {
    const card = $('#portalCard');
    const steps = $('#familyPortalSteps');
    let p = null;
    if (state.vault.unlocked) {
      try {
        p = await api('/api/family/portal');
      } catch (e) {
        p = null;
      }
    }
    const ready = Boolean(p && p.vaultFormat === 3);
    showWhen(card, ready && isCommander());
    if (steps) steps.hidden = !ready || isCommander();
    if (!ready) return;
    const portalRow = (item, editable) => {
      const children = [
        el('strong', { text: item.title }),
        item.contact ? el('p', { className: 'small', children: [el('span', { text: '📞 ' }), el('bdi', { className: 'mono', text: item.contact, attrs: { dir: 'ltr' } })] }) : null,
        item.textAr ? el('p', { className: 'small pre-wrap', text: item.textAr }) : null,
        item.url ? el('p', { className: 'small', children: [safeLink(item.url)] }) : null,
      ];
      if (editable) {
        children.push(
          el('div', {
            className: 'toolbar',
            children: [
              button('✏️ تعديل', 'btn-ghost btn-sm', () => openPortalDialog(item.category, item)),
              button('🗑️ حذف', 'btn-ghost btn-sm', () => deletePortalItem(item)),
            ],
          })
        );
      }
      return el('div', { className: 'list-item', children: children });
    };
    const fill = (box, list, editable, emptyAr) => {
      if (!box) return;
      box.replaceChildren(...(list.length ? list.map((i) => portalRow(i, editable)) : [el('p', { className: 'muted small', text: emptyAr })]));
    };
    const logRow = (e) =>
      el('div', {
        className: 'list-item small',
        children: [
          el('strong', { text: e.labelAr }),
          e.detailAr ? el('span', { text: ' — ' + e.detailAr }) : null,
          el('span', { className: 'muted', text: ' · ' + formatDateAr(e.at) + ' · ' + e.deviceName + (e.actor === 'commander' ? ' (القائد)' : '') }),
        ],
      });
    if (isCommander()) {
      fill($('#portalContacts'), p.contacts, true, 'لا جهات اتصال بعد. أضف مثلاً: المحاسب، والمبرمج الموثوق، ودعم الاستضافة.');
      fill($('#portalInstructions'), p.instructions, true, 'لا تعليمات بعد. أضف مثلاً: كيف تُضيف مبرمجاً كمتعاون دون إعطائه كلمة المرور.');
      $('#portalLogCount').textContent = String(p.logTotal);
      $('#portalLog').replaceChildren(...(p.log.length ? p.log.slice(0, 100).map(logRow) : [el('p', { className: 'muted small', text: 'لم يُسجَّل شيء بعد.' })]));
      return;
    }
    fill($('#familyContacts'), p.contacts, false, 'لم تُضَف جهات اتصال بعد.');
    fill($('#familyInstructions'), p.instructions, false, 'لم تُضَف تعليمات بعد.');
    $('#familyBills').replaceChildren(
      ...(p.bills.length
        ? p.bills.map((b) => el('div', { className: 'list-item', children: [el('strong', { text: (b.source === 'project' ? '📱 ' : '💳 ') + b.title }), b.detailAr ? el('p', { className: 'small pre-wrap', text: b.detailAr }) : null, b.url ? el('p', { className: 'small', children: [safeLink(b.url)] }) : null] }))
        : [el('p', { className: 'muted small', text: 'لا فواتير مسجلة.' })])
    );
    $('#familyLog').replaceChildren(...p.log.slice(0, 50).map(logRow));
  }

  /**
   * 3.2.0: قياس دعم Passkeys وامتداد PRF في هذا المتصفح. يُرسل إلى الخادم الخلاصة فقط، لا ناتج PRF.
   */
  function probeHostOk() {
    return location.hostname === 'localhost';
  }

  function renderProbeHost() {
    const warn = $('#probeHostWarn');
    if (!warn) return;
    const ok = probeHostOk();
    warn.hidden = ok;
    $$('[data-action="passkey-probe"]').forEach((b) => (b.disabled = !ok));
    if (!ok) {
      const url = 'http://localhost:' + location.port + '/';
      warn.replaceChildren(el('span', { text: '⚠️ Passkeys لا تعمل على العنوان ' + location.host + '. افتح البرنامج على ' }), safeLink(url), el('span', { text: ' (ستحتاج فتح الخزنة مرة أخرى هناك).' }));
    }
  }

  async function loadProbeReports() {
    const box = $('#probeReports');
    if (!box || !isCommander()) return;
    renderProbeHost();
    let r;
    try {
      r = await api('/api/passkeys/probe/reports');
    } catch (e) {
      return;
    }
    box.replaceChildren(
      ...r.reports.slice(0, 10).map((p) =>
        el('div', {
          className: 'list-item small',
          children: [
            el('strong', { text: p.verdictAr }),
            el('p', { className: 'muted', text: formatDateAr(p.at) + ' · ' + p.deviceName + ' · ' + (p.requested === 'platform' ? 'مصادق الجهاز' : 'هاتف أو مفتاح أمان') + (p.attachment ? ' (' + p.attachment + ')' : '') + ' · ' + p.platform }),
          ],
        })
      )
    );
  }

  function randomBytes(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  async function runPasskeyProbe(btn) {
    if (!probeHostOk()) return renderProbeHost();
    const requested = btn.dataset.attachment === 'cross-platform' ? 'cross-platform' : 'platform';
    const r = {
      requested: requested,
      userAgent: navigator.userAgent,
      platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
      origin: location.origin,
      webauthn: Boolean(window.PublicKeyCredential && navigator.credentials),
      platformAuthenticator: null,
      clientPrfCapability: null,
      created: false,
      attachment: null,
      createPrfEnabled: null,
      getPrfReturned: false,
      prfLength: 0,
      prfStable: false,
      userVerified: false,
      errorName: null,
      errorStep: null,
    };
    let step = 'capabilities';
    await busy(btn, async () => {
      try {
        if (r.webauthn) {
          r.platformAuthenticator = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
          if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
            const caps = await PublicKeyCredential.getClientCapabilities();
            if (caps && Object.prototype.hasOwnProperty.call(caps, 'extension:prf')) r.clientPrfCapability = caps['extension:prf'] === true;
          }
          const salt = randomBytes(32);
          step = 'create';
          const cred = await navigator.credentials.create({
            publicKey: {
              rp: { name: 'Second Brain', id: location.hostname },
              user: { id: randomBytes(16), name: 'second-brain-probe', displayName: 'Second Brain — قياس' },
              challenge: randomBytes(32),
              pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 },
              ],
              authenticatorSelection: { authenticatorAttachment: requested, residentKey: 'preferred', userVerification: 'required' },
              timeout: 120000,
              extensions: { prf: { eval: { first: salt } } },
            },
          });
          r.created = true;
          r.attachment = cred.authenticatorAttachment || null;
          const ce = cred.getClientExtensionResults() || {};
          r.createPrfEnabled = ce.prf && typeof ce.prf.enabled === 'boolean' ? ce.prf.enabled : null;
          const assert = async () => {
            const a = await navigator.credentials.get({
              publicKey: {
                challenge: randomBytes(32),
                rpId: location.hostname,
                allowCredentials: [{ type: 'public-key', id: cred.rawId }],
                userVerification: 'required',
                timeout: 120000,
                extensions: { prf: { eval: { first: salt } } },
              },
            });
            const e = a.getClientExtensionResults() || {};
            const flags = new Uint8Array(a.response.authenticatorData)[32];
            return { prf: e.prf && e.prf.results && e.prf.results.first ? new Uint8Array(e.prf.results.first) : null, uv: Boolean(flags & 4) };
          };
          step = 'get-1';
          const g1 = await assert();
          step = 'get-2';
          const g2 = await assert();
          r.userVerified = g1.uv && g2.uv;
          r.getPrfReturned = Boolean(g1.prf);
          r.prfLength = g1.prf ? g1.prf.length : 0;
          r.prfStable = Boolean(g1.prf && g2.prf && g1.prf.length === g2.prf.length && g1.prf.every((v, i) => v === g2.prf[i]));
          // ناتج PRF يبقى في هذه الدالة فقط، ولا يُرسل
          g1.prf && g1.prf.fill(0);
          g2.prf && g2.prf.fill(0);
        }
      } catch (err) {
        r.errorName = (err && err.name) || 'Error';
        r.errorStep = step;
      }
      const data = await api('/api/passkeys/probe/report', r);
      const p = data.report;
      const box = $('#probeReport');
      box.hidden = false;
      box.textContent = [
        p.verdictAr,
        '',
        'المتصفح يدعم WebAuthn: ' + (p.webauthn ? 'نعم' : 'لا'),
        'مصادق مدمج (وجه/بصمة/رمز): ' + (p.platformAuthenticator === null ? '—' : p.platformAuthenticator ? 'نعم' : 'لا'),
        'المتصفح يعلن PRF: ' + (p.clientPrfCapability === null ? 'لا يُعرف' : p.clientPrfCapability ? 'نعم' : 'لا'),
        'أُنشئ Passkey: ' + (p.created ? 'نعم' + (p.attachment ? ' (' + p.attachment + ')' : '') : 'لا'),
        'PRF عند الإنشاء: ' + (p.createPrfEnabled === null ? 'لم يُذكر' : p.createPrfEnabled ? 'مفعّل' : 'غير مفعّل'),
        'PRF عند التحقق: ' + (p.getPrfReturned ? 'أعاد ' + p.prfLength + ' بايت، ' + (p.prfStable ? 'ثابت في المرتين' : 'يتغيّر!') : 'لم يُعِد شيئاً'),
        'تحقق منك (UV): ' + (p.userVerified ? 'نعم' : 'لا'),
        p.errorName ? 'خطأ: ' + p.errorName + ' في خطوة ' + p.errorStep : '',
      ]
        .filter((x) => x !== null)
        .join('\n');
      await loadProbeReports();
    });
  }

  /**
   * 3.4.0: مسح باركود مفتاح الطوارئ بالكاميرا (BarcodeDetector في المتصفح: Chrome على الماك و Android).
   *        الصورة تبقى في الذاكرة ولا تُرسل، والكاميرا تُغلق فور القراءة أو الإغلاق.
   */
  async function setupKeyScanner() {
    const btns = $$('[data-action="scan-key"]');
    if (!btns.length) return;
    let ok = false;
    try {
      ok = 'BarcodeDetector' in window && Boolean(navigator.mediaDevices) && (await window.BarcodeDetector.getSupportedFormats()).indexOf('qr_code') >= 0;
    } catch (e) {
      ok = false;
    }
    btns.forEach((b) => (b.hidden = !ok));
  }

  async function scanKeyIntoForm(btn) {
    const input = btn.closest('form').elements.key;
    const dialog = $('#scanDialog');
    const video = $('#scanVideo');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      toast('تعذّر فتح الكاميرا. اكتبي المفتاح بيدكِ.', 'error');
      return;
    }
    let done = false;
    const stop = () => {
      done = true;
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      if (dialog.open) dialog.close();
    };
    dialog.addEventListener('close', stop, { once: true });
    video.srcObject = stream;
    dialog.showModal();
    try {
      await video.play();
    } catch (e) {
      /* يبدأ التشغيل وحده */
    }
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    while (!done) {
      try {
        const found = (await detector.detect(video)).map((c) => String(c.rawValue || '').trim()).find((v) => /^SB-[0-9A-F-]{20,}$/i.test(v));
        if (found) {
          input.value = found;
          stop();
          toast('📷 قُرئ المفتاح. اضغطي «فتح الحسابات».', 'ok');
          return;
        }
      } catch (e) {
        /* إطار غير جاهز بعد */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * 3.8.0: أدوات MCP (تفعيل وتعطيل لكل أداة) وسجل عملياتها
   */
  const MCP_RESULT_AR = { ok: '✅ نجحت', error: '⚠️ خطأ', disabled: '⛔ معطّلة', invalid: '❓ معاملات غير صالحة', unknown_tool: '❓ أداة غير معروفة' };

  // ===================== 4.0.1: المعرفة (قائمة المراجعة والنسخة المحلية لـ MCP) =====================
  async function loadKnowledge() {
    const card = $('#knowledgeReviewCard');
    const row = $('#knowledgeDeviceKeyRow');
    if (!isCommander()) {
      showWhen(card, false);
      showWhen(row, false);
      return;
    }
    let status;
    let review;
    try {
      status = await api('/api/knowledge/status');
      review = await api('/api/knowledge/review');
    } catch (e) {
      return;
    }
    if (row) {
      showWhen(row, true);
      $('#knowledgeDeviceKey').checked = status.deviceKey.enabled;
    }
    if (!card) return;
    showWhen(card, true);
    loadExtraction();
    $('#knowledgeReviewCount').textContent = String(review.items.length);
    $('#knowledgeStatusLine').textContent = status.summaryAr;
    $('#knowledgeReviewList').replaceChildren(
      ...(review.items.length
        ? review.items.map((it) =>
            el('div', {
              className: 'list-item',
              children: [
                el('div', { children: [el('span', { className: 'badge', text: it.node.typeAr }), el('strong', { text: ' ' + it.node.title })] }),
                it.node.body && it.node.body !== it.node.title ? el('p', { className: 'small', text: it.node.body.slice(0, 600) }) : null,
                el('p', { className: 'small muted', text: it.reasonAr + (it.node.projectId ? ' · مشروع: ' + it.node.projectId : '') + ' · ' + formatDateAr(it.createdAt) }),
                it.links.length ? el('p', { className: 'small muted', text: it.links.map((l) => '↔ ' + l.relationAr + ': ' + l.title).join(' · ') }) : null,
                el('div', {
                  className: 'card-actions',
                  children: [
                    button('✅ اعتماد', 'btn-primary btn-sm', (e) => decideKnowledge(it.id, 'approve', e.currentTarget)),
                    button('❌ رفض', 'btn-ghost btn-sm', (e) => decideKnowledge(it.id, 'reject', e.currentTarget)),
                  ],
                }),
              ],
            })
          )
        : [el('p', { className: 'muted small', text: 'لا اقتراحات تنتظر مراجعتك.' })])
    );
  }

  // ===================== 4.1.0: لوحة «🧠 المعرفة» (المخطط والخط الزمني) =====================
  const kv = { graph: null, data: null, selected: null, pendingFocus: null, pendingMarks: null, fitTimer: null };

  function knowledgeQuery() {
    const params = new URLSearchParams();
    const project = $('#knowledgeProject').value;
    const type = $('#knowledgeType').value;
    if (project) params.set('project', project);
    if (type) params.set('type', type);
    const q = params.toString();
    return q ? '?' + q : '';
  }

  function resetKnowledgeDetail() {
    kv.selected = null;
    $('#knowledgeDetail').replaceChildren(el('p', { className: 'small muted', text: 'اضغط على عقدة في المخطط أو في الخط الزمني لعرض تفاصيلها.' }));
  }

  function fillSelect(sel, first, options) {
    const keep = sel.value;
    sel.replaceChildren(el('option', { text: first, attrs: { value: '' } }), ...options.map((o) => el('option', { text: o.label, attrs: { value: o.value } })));
    sel.value = options.some((o) => o.value === keep) ? keep : '';
  }

  /** يضبط التقريب على الكل حين تهدأ الحركة (ومرة فوراً حتى لا يبدأ العرض فارغاً) */
  function fitGraphWhenSettled() {
    clearTimeout(kv.fitTimer);
    const started = Date.now();
    const step = () => {
      if (!kv.graph) return;
      kv.graph.reset();
      if (!kv.graph.isSettled() && Date.now() - started < 6000) kv.fitTimer = setTimeout(step, 400);
      else if (kv.pendingFocus) {
        const id = kv.pendingFocus;
        kv.pendingFocus = null;
        kv.graph.focusOn(id);
        if (kv.pendingMarks) kv.graph.highlight(kv.pendingMarks);
        kv.pendingMarks = null;
        showKnowledgeNode(id);
      }
    };
    step();
  }

  async function loadKnowledgeView() {
    const ok = isCommander();
    showWhen($('#knowledgeBody'), ok);
    showWhen($('#knowledgeLockedNote'), !ok);
    if (!ok) {
      if (kv.graph) kv.graph.setData([], []);
      kv.data = null;
      resetKnowledgeDetail();
      $('#knowledgeTimeline').replaceChildren();
      $('#knowledgePendingBadge').textContent = '—'; // لا يبقى عدد قديم بعد القفل
      return;
    }
    if (kv.pendingFocus) {
      $('#knowledgeProject').value = '';
      $('#knowledgeType').value = '';
    }
    if (!kv.graph && window.SBGraphView) {
      kv.graph = window.SBGraphView.create($('#knowledgeCanvas'), { onSelect: (id) => (id ? showKnowledgeNode(id) : resetKnowledgeDetail()) });
    }
    const q = knowledgeQuery();
    let g;
    let t;
    let st;
    try {
      [g, t, st] = await Promise.all([api('/api/knowledge/graph' + q), api('/api/knowledge/timeline' + q), api('/api/knowledge/status')]);
    } catch (err) {
      toast('❌ ' + err.message, 'error');
      return;
    }
    kv.data = g;
    fillSelect($('#knowledgeProject'), 'كل المشاريع', g.projects.map((p) => ({ value: p.id, label: p.name })).concat([{ value: 'none', label: 'عامة (بلا مشروع)' }]));
    fillSelect($('#knowledgeType'), 'كل الأنواع', g.types.map((x) => ({ value: x.id, label: x.labelAr + ' (' + x.count + ')' })));
    $('#knowledgePendingBadge').textContent = String(st.pendingReview);
    $('#knowledgeGraphSummary').textContent = g.nodes.length ? '🕸️ ' + g.summaryAr + '.' : '';
    const colors = (window.SBGraphView && window.SBGraphView.TYPE_COLORS) || {};
    const present = new Set(g.nodes.map((n) => n.type));
    $('#knowledgeLegend').replaceChildren(
      ...g.types
        .filter((x) => present.has(x.id))
        .map((x) => {
          const dot = el('span', { className: 'legend-dot', attrs: { 'aria-hidden': 'true' } });
          dot.style.background = colors[x.id] || '#8fa9c4';
          return el('span', { className: 'legend-item', children: [dot, el('span', { text: x.labelAr })] });
        })
    );
    if (kv.graph) {
      kv.graph.setData(g.nodes, g.edges);
      if (kv.selected && !g.nodes.some((n) => n.id === kv.selected)) resetKnowledgeDetail();
      else if (kv.selected) kv.graph.select(kv.selected, false);
      applyKnowledgeSearch();
      fitGraphWhenSettled();
    }
    renderKnowledgeTimeline(t, g.totalNodes);
  }

  function renderKnowledgeTimeline(t, totalNodes) {
    $('#knowledgeTimelineSummary').textContent = t.total ? '— ' + t.summaryAr : '';
    if (!t.items.length) {
      $('#knowledgeTimeline').replaceChildren(
        el('p', { className: 'muted small', text: totalNodes ? 'لا شيء يطابق التصفية.' : 'المعرفة فارغة بعد. اعتمد اقتراحات من قائمة المراجعة، أو استخرج من محادثاتك في قسم «الذاكرة».' })
      );
      return;
    }
    const groups = [];
    let current = null;
    t.items.forEach((it) => {
      const month = it.createdAt.slice(0, 7);
      if (!current || current.month !== month) groups.push((current = { month, items: [] }));
      current.items.push(it);
    });
    $('#knowledgeTimeline').replaceChildren(
      ...groups.map((grp) =>
        el('section', {
          className: 'timeline-month',
          children: [
            el('h3', { text: new Date(grp.month + '-01T00:00:00Z').toLocaleDateString('ar', { year: 'numeric', month: 'long', timeZone: 'UTC' }) }),
            el('ul', {
              className: 'plain-list',
              children: grp.items.map((it) => {
                const b = button('', 'btn-ghost timeline-item', () => {
                  openKnowledgeNode(it.id);
                  // الخط الزمني تحت المخطط: نصعد إليه حتى يرى القائد العقدة وتفاصيلها
                  $('.knowledge-layout').scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
                b.replaceChildren(
                  el('span', { className: 'badge', text: it.typeAr }),
                  el('span', { className: 'timeline-title', text: it.title }),
                  el('span', { className: 'muted small', text: formatDateAr(it.createdAt) + (it.status !== 'active' ? ' · ' + it.statusAr : '') + (it.links ? ' · 🔗 ' + it.links : '') })
                );
                if (it.status !== 'active') b.classList.add('is-faded');
                return el('li', { children: [b] });
              }),
            }),
          ],
        })
      )
    );
  }

  /** من الخط الزمني أو من علاقة: يحرّك المخطط إلى العقدة ويعرض تفاصيلها */
  function openKnowledgeNode(id) {
    if (kv.graph) kv.graph.focusOn(id);
    showKnowledgeNode(id);
  }

  /** من صفحة المشروع: يفتح لوحة المعرفة على العقدة */
  function openKnowledgeAt(id, marks) {
    kv.pendingFocus = id;
    kv.pendingMarks = marks && marks.length > 1 ? marks : null;
    $('#knowledgeSearch').value = '';
    setView('knowledge');
    window.scrollTo({ top: 0 }); // صفحة المشروع طويلة، والمخطط أعلى اللوحة
  }

  async function showKnowledgeNode(id) {
    kv.selected = id;
    let d;
    try {
      d = (await api('/api/knowledge/node?id=' + encodeURIComponent(id))).node;
    } catch (err) {
      toast('❌ ' + err.message, 'error');
      return;
    }
    if (kv.selected !== id) return; // ضغطة أحدث سبقت هذا الرد
    const project = kv.data && d.projectId ? kv.data.projects.find((p) => p.id.toLowerCase() === d.projectId.toLowerCase()) : null;
    const meta = [d.statusAr, d.confidenceAr, d.sourceAr, d.projectId ? 'مشروع: ' + (project ? project.name : d.projectId) : 'عامة', formatDateAr(d.createdAt)];
    // replaceChildren يحوّل null إلى النص «null»، فتُصفّى العناصر الغائبة أولاً
    const parts = [
      el('div', { children: [el('span', { className: 'badge', text: d.typeAr }), d.status !== 'active' ? el('span', { className: 'badge warn', text: d.statusAr }) : null] }),
      el('h3', { text: d.title }),
      d.body && d.body !== d.title ? el('p', { className: 'small knowledge-body', text: d.body }) : null,
      el('p', { className: 'small muted', text: meta.join(' · ') }),
      el('p', { className: 'small muted mono', text: d.id, attrs: { dir: 'ltr' } }),
      el('h4', { text: d.links.length ? '🔗 العلاقات (' + d.links.length + ')' : '🔗 لا علاقات بعد' }),
      d.links.length
        ? el('ul', {
            className: 'plain-list knowledge-links',
            children: d.links.map((l) => {
              const b = button('', 'btn-ghost btn-sm', () => openKnowledgeNode(l.node.id));
              b.replaceChildren(el('span', { className: 'muted', text: l.relationAr + ' ' }), el('span', { text: '«' + l.node.title + '»' }), el('span', { className: 'muted small', text: ' · ' + l.node.typeAr }));
              return el('li', { children: [b] });
            }),
          })
        : null,
    ];
    $('#knowledgeDetail').replaceChildren(...parts.filter(Boolean));
  }

  function applyKnowledgeSearch() {
    if (!kv.graph || !kv.data) return [];
    const q = $('#knowledgeSearch').value.trim().toLowerCase();
    if (!q) {
      kv.graph.highlight(null);
      return [];
    }
    const ids = kv.data.nodes.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase() === q).map((n) => n.id);
    kv.graph.highlight(ids.length ? ids : ['__none__']);
    return ids;
  }

  // 4.1.0: سجل قرارات المشروع (متى، وماذا، ولماذا، ومن أين، وما استبدله وما استُبدل به)
  async function loadDecisionLog(projectId, box) {
    let d;
    try {
      d = await api('/api/knowledge/decisions?project=' + encodeURIComponent(projectId));
    } catch (err) {
      box.replaceChildren(el('p', { className: 'small muted', text: '⚠️ ' + err.message }));
      return;
    }
    if (state.projectId !== projectId) return;
    const titles = (list) => list.map((n) => '«' + n.title + '»').join('، ');
    box.replaceChildren(
      el('p', { className: 'small muted', text: d.summaryAr + (d.items.length ? '، الأحدث أولاً، والمُستبدَل يبقى للتاريخ.' : ' اعتمد اقتراحات من قائمة المراجعة، أو استخرج من محادثات المشروع.') }),
      ...d.items.map((it) =>
        el('div', {
          className: 'list-item decision-item' + (it.status !== 'active' ? ' is-faded' : ''),
          children: [
            el('div', { children: [el('strong', { text: it.title }), it.status !== 'active' ? el('span', { className: 'badge warn', text: it.statusAr }) : null] }),
            it.body && it.body !== it.title ? el('p', { className: 'small', children: [el('strong', { text: 'لماذا: ' }), el('span', { text: it.body })] }) : null,
            el('p', { className: 'small muted', text: '🕒 ' + formatDateAr(it.createdAt) + ' · ' + it.sourceAr + ' · ' + it.confidenceAr }),
            it.decidedIn.length ? el('p', { className: 'small', text: '💬 اتُّخذ في: ' + it.decidedIn.map((n) => '«' + n.title + '» (' + formatDateAr(n.createdAt) + ')').join('، ') }) : null,
            it.supersedes.length ? el('p', { className: 'small', text: '↩️ استبدل: ' + titles(it.supersedes) }) : null,
            it.supersededBy.length ? el('p', { className: 'small', text: '⏭️ استُبدل بـ: ' + titles(it.supersededBy) }) : null,
            it.affects.length ? el('p', { className: 'small', text: '🎯 أثّر على: ' + titles(it.affects) }) : null,
            el('div', { className: 'card-actions', children: [button('🕸️ في المخطط', 'btn-ghost btn-sm', () => openKnowledgeAt(it.id))] }),
          ],
        })
      )
    );
  }

  // 4.0.2: الاستخراج بالذكاء (بزر يدوي، والمزوّد يُختار ويُغيَّر في أي وقت)
  let extractPoll = null;
  async function loadExtraction() {
    if (!isCommander() || !$('#extractProvider')) return;
    let d;
    try {
      d = await api('/api/knowledge/extract');
    } catch (e) {
      return;
    }
    const sel = $('#extractProvider');
    if (!sel.options.length || sel.dataset.loaded !== '1') {
      sel.replaceChildren(...d.providers.map((p) => el('option', { text: p.labelAr + (p.configured ? '' : ' — غير مهيّأ'), attrs: { value: p.id } })));
      sel.dataset.loaded = '1';
    }
    sel.value = d.choice;
    renderExtractionJob(d.job, d);
    if (d.job.running && !extractPoll) extractPoll = setInterval(pollExtraction, 2000);
  }

  function renderExtractionJob(job, d) {
    const running = job.running;
    $('[data-action="extract-start"]').disabled = running;
    $('[data-action="extract-cancel"]').hidden = !running;
    $('#extractProvider').disabled = running;
    const lines = [];
    // «في هذه الدفعة»: كل ضغطة تقرأ 50 محادثة على الأكثر، والباقي في الضغطة التالية
    if (running) lines.push('⏳ يستخرج: ' + job.done + ' من ' + job.total + ' في هذه الدفعة' + (job.current ? ' — «' + job.current + '»' : '') + ' · اقتراحات حتى الآن: ' + job.proposals);
    else if (job.finishedAt) {
      lines.push((job.cancelled ? '⏹️ أُوقف' : '✅ انتهى') + ': ' + job.done + ' من ' + job.total + ' في هذه الدفعة · اقتراحات جديدة: ' + job.proposals + (job.conflicts ? ' · ⚠️ تعارض مع قرارات أقدم: ' + job.conflicts : '') + (job.duplicates ? ' · مكرر لم يُقترح: ' + job.duplicates : ''));
      // الأخطاء المتطابقة سطر واحد بعددها
      const grouped = {};
      job.errors.forEach((e) => (grouped[e.messageAr] = (grouped[e.messageAr] || 0) + 1));
      Object.keys(grouped).forEach((m) => lines.push('⚠️ ' + (grouped[m] > 1 ? '(' + grouped[m] + ' مرات) ' : '') + m));
    }
    if (d) lines.push(d.counts.new + d.counts.changed ? '📥 بانتظار الاستخراج: ' + d.pendingAr + ' (كل ضغطة تقرأ 50 على الأكثر).' : 'لا محادثات جديدة للاستخراج منها.');
    $('#extractInfo').replaceChildren(...lines.map((l) => el('span', { className: 'block', text: l })));
  }

  async function pollExtraction() {
    let d;
    try {
      d = await api('/api/knowledge/extract');
    } catch (e) {
      clearInterval(extractPoll);
      extractPoll = null;
      return;
    }
    renderExtractionJob(d.job, d);
    if (!d.job.running) {
      clearInterval(extractPoll);
      extractPoll = null;
      await loadKnowledge();
    }
  }

  async function decideKnowledge(id, decision, btn) {
    await busy(btn, async () => {
      const d = await api('/api/knowledge/review/decide', { id: id, decision: decision });
      toast(d.messageAr, 'ok');
      await loadKnowledge();
    });
  }

  async function loadMcpTools() {
    loadKnowledge();
    const box = $('#mcpTools');
    if (!box || !isCommander()) return;
    let r;
    try {
      r = await api('/api/mcp/tools');
    } catch (e) {
      return;
    }
    box.replaceChildren(
      ...r.tools.map((t) => {
        const input = el('input', { attrs: Object.assign({ type: 'checkbox' }, t.enabled ? { checked: 'checked' } : {}) });
        input.addEventListener('change', async () => {
          input.disabled = true;
          try {
            const d = await api('/api/mcp/tools', { name: t.name, enabled: input.checked });
            toast(d.messageAr, 'ok');
          } catch (err) {
            input.checked = !input.checked;
            toast('❌ ' + err.message, 'error');
          } finally {
            input.disabled = false;
          }
        });
        return el('label', {
          className: 'check list-item',
          children: [input, el('span', { children: [el('strong', { text: t.title }), el('bdi', { className: 'mono muted small', text: ' ' + t.name, attrs: { dir: 'ltr' } }), t.writes ? el('span', { className: 'badge warn', text: 'تكتب في الذاكرة' }) : null] })],
        });
      })
    );
    $('#mcpAudit').replaceChildren(
      ...(r.audit.length
        ? r.audit.slice(0, 50).map((a) =>
            el('div', {
              className: 'list-item small',
              children: [
                el('strong', { text: MCP_RESULT_AR[a.result] || a.result }),
                el('bdi', { className: 'mono', text: ' ' + a.tool, attrs: { dir: 'ltr' } }),
                el('span', { className: 'muted', text: ' · ' + formatDateAr(a.at) + ' · ' + a.client + (a.clientVersion ? ' ' + a.clientVersion : '') + (a.projectId ? ' · مشروع: ' + a.projectId : '') + ' · ' + a.durationMs + 'ms' }),
              ],
            })
          )
        : [el('p', { className: 'muted small', text: 'لا عمليات مسجّلة بعد.' })])
    );
  }

  function openPortalDialog(category, item) {
    const dialog = $('#portalDialog');
    const form = $('[data-form="portal-item"]');
    form.reset();
    const contact = category === 'contact';
    form.elements.category.value = category;
    form.elements.id.value = item ? item.id : '';
    form.elements.title.value = item ? item.title : '';
    form.elements.contact.value = item ? item.contact : '';
    form.elements.url.value = item ? item.url : '';
    form.elements.textAr.value = item ? item.textAr : '';
    $('#portalDialogTitle').textContent = (item ? '✏️ تعديل: ' : contact ? '➕ جهة اتصال' : '➕ تعليمة للعائلة') + (item ? item.title : '');
    $('[data-portal-label="title"]', form).textContent = contact ? 'الاسم (ومن هو)' : 'عنوان التعليمة';
    $('[data-portal-label="text"]', form).textContent = contact ? 'متى تتصل به العائلة؟ ولماذا؟' : 'التعليمة خطوة بخطوة';
    $('[data-portal-only="contact"]', form).hidden = !contact;
    form.elements.textAr.required = !contact;
    dialog.showModal();
    form.elements.title.focus();
  }

  async function deletePortalItem(item) {
    if (!window.confirm('حذف "' + item.title + '" من بوابة العائلة؟')) return;
    await busy(null, async () => {
      const data = await api('/api/family/portal/item/delete', { id: item.id });
      toast(data.messageAr, 'ok');
      await loadPortal();
    });
  }

  /**
   * ISS-033: إظهار عنصر حسب شرط، مع حفظ الشرط حتى لا يُظهره renderVaultChrome لاحقاً بالخطأ.
   */
  function showWhen(node, shown) {
    if (!node) return;
    node.dataset.shownWhen = shown ? '1' : '0';
    node.hidden = !shown || (node.hasAttribute('data-commander-only') && !isCommander());
  }

  function renderVaultChrome() {
    const v = state.vault;
    $('#vaultSetup').hidden = v.exists;
    $('#vaultUnlock').hidden = !v.exists || v.unlocked;
    $('#vaultOpen').hidden = !v.unlocked;
    $('#vaultToolbar').hidden = !v.unlocked;
    // ISS-033: عنصر له شرط ظهور خاص (data-shown-when) لا يُظهره القائد إن كان شرطه «0»
    $$('[data-commander-only]').forEach((n) => (n.hidden = !isCommander() || n.dataset.shownWhen === '0'));

    const chip = $('#chipVault');
    chip.textContent = !v.exists ? 'غير مُنشأة' : v.unlocked ? 'مفتوحة' : 'مقفلة';
    $('#chipVaultWrap').classList.toggle('is-open', v.unlocked);
    $('#familyVaultStatus').textContent = !v.exists
      ? 'لم تُنشأ الخزنة على هذا الجهاز. إن كان لديكِ ملف نسخة احتياطية استخدمي "استعادة نسخة احتياطية" بالأسفل.'
      : v.unlocked
        ? v.unlockedBy === 'commander' ? '🔓 الخزنة مفتوحة — ' + v.secretsCount + ' عنصر.' : v.vaultFormat === 3 ? '👪 الخزنة العائلية مفتوحة — ' + v.secretsCount + ' عنصر.' : '🔓 الخزنة مفتوحة — ' + v.secretsCount + ' عنصر.'
        : '🔒 الخزنة مقفلة.';
    updateAutoLockBadge();
  }

  /**
   * 3.0.0: بطاقة الخزنة العائلية: الترقية (v2) أو الحالة والنسخ القديمة (v3)
   */
  async function loadFamilyVault() {
    const card = $('#familyVaultCard');
    if (!card) return;
    if (!isCommander()) {
      showWhen(card, false);
      return;
    }
    let r;
    try {
      r = await api('/api/vault/family');
    } catch (e) {
      showWhen(card, false);
      return;
    }
    showWhen(card, true);
    const upgraded = r.vaultFormat === 3;
    $('#familyVaultInfo').textContent = upgraded
      ? '✅ الخزنة العائلية مفعّلة: ' + r.familyCount + ' سرّاً يظهر للعائلة. مفتاح الطوارئ يفتحها وحدها، ولا يصل إلى أسرارك ولا محادثاتك.'
      : '⚠️ الخزنة بالصيغة القديمة: مفتاح الطوارئ المطبوع يفتح كل شيء. رقِّها إلى الخزنة العائلية.';
    $('#familyMigrate').hidden = upgraded;
    if (!upgraded) {
      $('#familySuggestList').replaceChildren(
        ...(r.suggestions.length
          ? r.suggestions.map((sg) =>
              el('label', {
                className: 'check list-item',
                children: [
                  el('input', { attrs: Object.assign({ type: 'checkbox', value: sg.id, 'data-family-pick': '1' }, sg.suggested ? { checked: 'checked' } : {}) }),
                  el('span', { children: [el('strong', { text: sg.title }), el('span', { className: 'muted small', text: ' — ' + (CATEGORY_LABELS[sg.category] || sg.category) + (sg.reasonAr ? ' · ' + sg.reasonAr : '') })] }),
                ],
              })
            )
          : [el('p', { className: 'muted small', text: 'لا أسرار في الخزنة بعد. يمكنك الترقية الآن وتعليم الأسرار لاحقاً.' })])
      );
    }
    const old = upgraded ? r.oldCopies || [] : [];
    $('#familyOldCopies').hidden = !old.length;
    if (old.length) {
      $('#familyOldList').replaceChildren(
        ...old.slice(0, 30).map((c) => el('div', { className: 'list-item small', children: [el('strong', { text: c.labelAr }), el('bdi', { className: 'mono muted', text: ' ' + c.fileName, attrs: { dir: 'ltr' } }), el('span', { className: 'muted', text: ' · ' + formatDateAr(c.modifiedAt) })] })),
        ...(old.length > 30 ? [el('p', { className: 'muted small', text: '… و' + (old.length - 30) + ' غيرها' })] : [])
      );
    }
  }

  function updateAutoLockBadge() {
    const badge = $('#autoLockBadge');
    if (!state.autoLockAt) {
      badge.textContent = '';
      return;
    }
    const minutes = Math.max(0, Math.ceil((state.autoLockAt - Date.now()) / 60000));
    badge.textContent = (state.vault.unlockedBy === 'commander' ? '🔓 القائد' : '🔓 مفتاح الطوارئ') + ' — قفل تلقائي بعد ' + minutes + ' د';
  }

  async function loadSecrets() {
    try {
      const data = await api('/api/vault/secrets');
      state.secrets = data.secrets;
    } catch (e) {
      state.secrets = [];
    }
    renderSecrets();
  }

  function renderSecrets() {
    renderSecretList($('#secretsList'), false);
    renderSecretList($('#familySecretsList'), true);
  }

  function renderSecretList(container, familyView) {
    container.replaceChildren();
    if (!state.vault.unlocked) return;
    const term = familyView ? '' : ($('#secretSearch').value || '').trim().toLowerCase();
    const category = familyView ? '' : $('#secretFilter').value;
    const items = state.secrets.filter((s) => {
      if (PORTAL_CATEGORIES.indexOf(s.category) >= 0) return false;
      if (familyView && s.category === 'api_key') return false;
      if (category && s.category !== category) return false;
      if (!term) return true;
      return [s.title, s.usernameOrEmail, s.url, s.notesForWifeAr, s.notesForCommanderAr].join(' ').toLowerCase().indexOf(term) >= 0;
    });
    if (!items.length) {
      container.appendChild(el('div', { className: 'empty-state', text: term || category ? 'لا توجد نتائج.' : 'لا توجد عناصر محفوظة بعد.' }));
      return;
    }
    items.forEach((s) => container.appendChild(buildSecretCard(s, familyView)));
  }

  function copyButton(text, label) {
    const b = button(label, 'btn-ghost btn-sm', async () => {
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = '✓ نُسخ';
        setTimeout(() => (b.textContent = label), 1500);
        setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30000);
      } catch (e) {
        toast('تعذر النسخ إلى الحافظة.', 'error');
      }
    });
    return b;
  }

  function buildSecretCard(s, familyView) {
    const card = el('article', { className: 'card secret-card' });
    card.appendChild(
      el('div', {
        className: 'secret-head',
        children: [
          el('h3', { text: s.title }),
          el('span', { className: 'badge', text: CATEGORY_LABELS[s.category] || s.category }),
          !familyView && s.familyVisible ? el('span', { className: 'badge ok', text: '👪 للعائلة', attrs: { title: 'يظهر في الخزنة العائلية (مفتاح الطوارئ)' } }) : null,
        ],
      })
    );

    if (s.usernameOrEmail) {
      card.appendChild(el('div', { className: 'secret-field', children: [el('span', { className: 'value', text: s.usernameOrEmail }), el('span', { className: 'btns', children: [copyButton(s.usernameOrEmail, 'نسخ')] })] }));
    }

    if (s.category === 'critical_file') {
      card.appendChild(el('p', { className: 'small mono', text: s.originalFilePath }));
      card.appendChild(el('p', { className: 'small muted', text: 'نسخ محفوظة: ' + s.versionsCount }));
    } else {
      const value = el('span', { className: 'value', text: MASK });
      let shown = false;
      const toggle = button('إظهار', 'btn-ghost btn-sm', () => {
        shown = !shown;
        value.textContent = shown ? s.secretValue : MASK;
        toggle.textContent = shown ? 'إخفاء' : 'إظهار';
      });
      card.appendChild(el('div', { className: 'secret-field', children: [value, el('span', { className: 'btns', children: [toggle, copyButton(s.secretValue, 'نسخ')] })] }));
    }

    if (s.url) card.appendChild(el('p', { className: 'small', children: [safeLink(s.url)] }));
    if (s.notesForWifeAr) card.appendChild(el('p', { className: 'secret-note', text: '💬 ' + s.notesForWifeAr }));
    if (!familyView && s.notesForCommanderAr) card.appendChild(el('p', { className: 'small muted', text: '📝 ' + s.notesForCommanderAr }));

    if (!familyView && isCommander() && s.category !== 'critical_file') {
      card.appendChild(
        el('div', {
          className: 'card-actions',
          children: [button('✏️ تعديل', 'btn-ghost btn-sm', () => openSecretDialog(s)), button('🗑️ حذف', 'btn-danger btn-sm', () => deleteSecret(s))],
        })
      );
    }
    return card;
  }

  function openSecretDialog(secret) {
    const dialog = $('#secretDialog');
    const form = $('[data-form="secret"]');
    form.reset();
    $('#secretDialogTitle').textContent = secret ? 'تعديل: ' + secret.title : 'عنصر جديد';
    if (secret) {
      ['id', 'category', 'title', 'usernameOrEmail', 'secretValue', 'url', 'notesForWifeAr', 'notesForCommanderAr'].forEach((k) => {
        if (form.elements[k]) form.elements[k].value = secret[k] || '';
      });
      if (form.elements.familyVisible) form.elements.familyVisible.checked = secret.familyVisible === true;
    } else {
      form.elements.id.value = '';
      form.elements.category.value = 'password';
    }
    dialog.showModal();
    form.elements.title.focus();
  }

  async function deleteSecret(s) {
    if (!window.confirm('حذف "' + s.title + '" من الخزنة نهائياً؟')) return;
    await busy(null, async () => {
      await api('/api/vault/secrets/delete', { id: s.id });
      toast('تم الحذف.', 'ok');
      await refreshVault();
    });
  }

  function passwordStrength(pw) {
    let score = 0;
    if (pw.length >= 10) score++;
    if (pw.length >= 14) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    if (pw.length < 10) score = Math.min(score, 1);
    return score;
  }

  function updateStrength(pw) {
    const s = passwordStrength(pw);
    const bar = $('#strengthBar');
    bar.className = s ? 's' + s : '';
    $('#strengthText').textContent = !pw ? '10 أحرف على الأقل؛ الأطول أقوى.' : ['ضعيفة جداً', 'ضعيفة', 'متوسطة', 'جيدة', 'قوية'][s];
  }

  function revealEmergencyKey(key, message) {
    setView('emergency');
    const box = $('#keyReveal');
    box.hidden = false;
    box.textContent = key;
    $('[data-form="kit"]').elements.emergencyKey.value = key;
    toast(message, 'warn', 15000);
  }

  // ===================== الذاكرة =====================
  function renderMemory() {
    const list = $('#memoryList');
    list.replaceChildren();
    const term = ($('#memorySearch').value || '').trim().toLowerCase();
    const items = state.memories.filter((m) => !term || [m.title, m.summaryAr, m.projectId].join(' ').toLowerCase().indexOf(term) >= 0);
    if (state.locked) {
      list.appendChild(el('div', { className: 'empty-state', text: '🔒 افتح الخزنة لعرض الذاكرة المشتركة.' }));
      return;
    }
    if (!items.length) {
      list.appendChild(el('div', { className: 'empty-state', text: term ? 'لا توجد نتائج.' : 'لا توجد سجلات ذاكرة بعد. ستظهر هنا عندما تحفظ أدوات الذكاء قراراتها عبر خادم الذاكرة.' }));
      return;
    }
    items.forEach((m) => {
      list.appendChild(
        el('article', {
          className: 'list-item',
          children: [
            el('div', { className: 'row', children: [el('strong', { text: '🧠 ' + m.title }), el('span', { className: 'meta', text: m.sourceAI + ' → ' + m.projectId + ' • ' + (m.createdAt || '').slice(0, 10) })] }),
            el('p', { className: 'small', text: m.summaryAr }),
          ],
        })
      );
    });
  }

  // ===================== الطوارئ والنسخ =====================
  async function loadBackups() {
    let data;
    try {
      data = await api('/api/emergency/backups');
    } catch (e) {
      return;
    }
    [['#backupsList', false], ['#familyBackupsList', true]].forEach(([sel, pick]) => {
      const box = $(sel);
      box.replaceChildren(el('div', { className: 'muted small', text: '📂 ' + data.backupsDir }));
      if (!data.backups.length) {
        box.appendChild(el('div', { className: 'muted', text: 'لا توجد نسخ احتياطية بعد.' }));
        return;
      }
      data.backups.slice(0, 6).forEach((b) => {
        const row = el('div', { className: 'row list-item', children: [el('span', { className: 'mono small', text: b.fileName + ' (' + Math.round(b.sizeBytes / 1024) + ' KB)' })] });
        if (pick) row.appendChild(button('اختيار', 'btn-ghost btn-sm', () => ($('[data-form="restore"]').elements.backupFile.value = b.filePath)));
        box.appendChild(row);
      });
    });
  }

  // ===================== الإعدادات =====================
  async function loadSettings() {
    try {
      state.settings = await api('/api/settings');
    } catch (err) {
      if (err.data && err.data.needsSettingsAuth) openSettingsAuth();
      else toast('تعذر تحميل الإعدادات: ' + err.message, 'error');
      return;
    }
    const form = $('[data-form="settings"]');
    form.hidden = false;
    $('#settingsLocked').hidden = true;
    const s = state.settings;
    const values = {
      identity: s.identity,
      ai: s.ai,
      connectors: s.connectors,
      watcher: s.watcher,
      security: s.security,
    };
    $$('input, select', form).forEach((field) => {
      const parts = field.name.split('.');
      if (parts.length !== 2 || !values[parts[0]]) return;
      const v = values[parts[0]][parts[1]];
      if (field.type === 'checkbox') field.checked = Boolean(v);
      else field.value = v === null || v === undefined ? '' : String(v);
    });
    const dl = $('#pathsList');
    dl.replaceChildren();
    Object.keys(s.readOnly.paths).forEach((k) => {
      dl.appendChild(el('dt', { text: k }));
      dl.appendChild(el('dd', { className: 'mono', text: s.readOnly.paths[k] }));
    });
    dl.appendChild(el('dt', { text: 'serverPort' }));
    dl.appendChild(el('dd', { className: 'mono', text: String(s.readOnly.serverPort) }));
    loadMaintenance();
  }

  // ===================== وضع التطوير والتصفير =====================
  async function loadMaintenance() {
    const panel = $('#devPanel');
    try {
      state.maintenance = await api('/api/maintenance');
    } catch (e) {
      panel.hidden = true;
      return;
    }
    panel.hidden = !state.maintenance.developerMode;
    const box = $('#trashList');
    box.replaceChildren();
    const trash = state.maintenance.trash;
    if (!trash.length) {
      box.appendChild(el('p', { className: 'small muted', text: 'السلة فارغة.' }));
      return;
    }
    box.appendChild(el('p', { className: 'small', text: 'محتوى السلة (الأحدث أولاً):' }));
    const ul = el('ul', { className: 'plain-list' });
    trash.forEach((b) => {
      const label = b.kind === 'reset' ? '🧹 تصفير' : '💾 حالة محفوظة قبل الاسترجاع';
      ul.appendChild(el('li', { text: label + ' — ' + b.createdAt.slice(0, 16).replace('T', ' ') + ' — ' + b.itemCount + ' عنصر' }));
    });
    box.appendChild(ul);
  }

  /** طلب عبارة التأكيد من المستخدم؛ المخرجات: النص المكتوب أو null عند الإلغاء */
  function askPhrase(message, phrase) {
    const typed = window.prompt(message + '\n\nللتأكيد اكتب: ' + phrase);
    return typed === null ? null : typed;
  }

  /** بعد التصفير أو الاسترجاع تتغير الخزنة كلها: نعيد تحميل الواجهة من البداية */
  function reloadAfterMaintenance(message) {
    toast(message, 'ok', 6000);
    setTimeout(() => window.location.reload(), 1800);
  }

  async function maintenanceCall(btn, pathName, body) {
    return busy(btn, async () => {
      try {
        return await api(pathName, body);
      } catch (err) {
        if (err.data && err.data.needsSettingsAuth) {
          toast('انتهت مدة صلاحية الإعدادات. أدخل كلمة المرور ثم أعد المحاولة.', 'warn');
          openSettingsAuth();
          return undefined;
        }
        throw err;
      }
    });
  }

  function collectSettings(form) {
    const out = { identity: {}, ai: {}, connectors: {}, watcher: {}, security: {} };
    $$('input, select', form).forEach((field) => {
      const parts = field.name.split('.');
      if (parts.length !== 2 || !out[parts[0]]) return;
      out[parts[0]][parts[1]] = field.type === 'checkbox' ? field.checked : field.type === 'number' ? Number(field.value) : field.value;
    });
    out.ai.providerOrder = state.settings ? state.settings.ai.providerOrder : null;
    return out;
  }

  // ===================== المحادثة =====================
  function chatLog(mode) {
    return mode === 'family' ? $('#familyChatLog') : $('#chatLog');
  }

  function appendMessage(mode, role, text) {
    const log = chatLog(mode);
    const empty = $('.chat-empty', log);
    if (empty) empty.remove();
    const msg = el('div', { className: 'msg msg-' + role, text: text });
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return msg;
  }

  function clearChat(mode) {
    state.chat[mode] = [];
    state.conversationId[mode] = null;
    state.unsavedWarned[mode] = false;
    const log = chatLog(mode);
    log.replaceChildren();
    if (mode === 'commander') log.appendChild(el('p', { className: 'chat-empty muted', text: 'بدأت محادثة جديدة.' }));
  }

  async function streamAssistant(question, mode, onText, onReset) {
    const res = await fetch('/api/assistant/stream', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question, mode: mode === 'family' ? 'wife_emergency' : 'commander', history: state.chat[mode].slice(-12), conversationId: state.conversationId[mode] || undefined }),
    });
    if (!res.ok || !res.body) {
      let data = {};
      try {
        data = await res.json();
      } catch (e) {
        /* بلا JSON */
      }
      throw new Error(data.error || 'خطأ ' + res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let meta = null;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let eventName = 'message';
        let data = '';
        block.split('\n').forEach((line) => {
          if (line.indexOf('event: ') === 0) eventName = line.slice(7);
          else if (line.indexOf('data: ') === 0) data += line.slice(6);
        });
        const payload = data ? JSON.parse(data) : {};
        if (eventName === 'delta') {
          answer += payload.text;
          onText(answer);
        } else if (eventName === 'reset') {
          answer = '';
          onReset();
        } else if (eventName === 'done') {
          meta = payload;
        } else if (eventName === 'error') {
          throw new Error(payload.error);
        }
      }
    }
    return { answer: answer, meta: meta };
  }

  async function ask(mode, questionText) {
    if (state.busy) return;
    const input = mode === 'family' ? $('#familyChatInput') : $('#chatInput');
    const question = (questionText || input.value).trim();
    if (!question) {
      input.focus();
      return;
    }
    state.busy = true;
    stopSpeaking(); // سؤال جديد يوقف نطق الرد السابق
    input.value = '';
    appendMessage(mode, 'user', question);
    const reply = appendMessage(mode, 'assistant', '⏳ جاري التفكير…');
    reply.classList.add('is-pending');
    const h = hologram();
    if (h) {
      h.setState('THINKING');
      h.pulse();
    }
    let shownLength = 0;
    try {
      const result = await streamAssistant(
        question,
        mode,
        (text) => {
          if (reply.classList.contains('is-pending')) {
            reply.classList.remove('is-pending');
            if (h) h.setState('SPEAKING');
          }
          // الموجة تنبض بقدر النص الجديد الذي وصل
          if (h && text.length > shownLength) h.feed(text.length - shownLength);
          shownLength = text.length;
          reply.textContent = text;
          chatLog(mode).scrollTop = chatLog(mode).scrollHeight;
        },
        () => {
          shownLength = 0;
          reply.classList.add('is-pending');
          reply.textContent = '⏳ المزوّد الأول تعذّر، جاري تجربة التالي…';
        }
      );
      state.chat[mode].push({ role: 'user', content: question }, { role: 'assistant', content: result.answer });
      state.lastAnswer[mode] = result.answer;
      if (result.meta) {
        const who = PROVIDER_NAMES[result.meta.providerUsed] || result.meta.providerUsed;
        reply.appendChild(el('span', { className: 'msg-meta', text: '— ' + who + (result.meta.providerUsed !== 'local' && result.meta.model ? ' (' + result.meta.model + ')' : '') }));
        // 4.1.0: العُقد التي استند إليها الرد تُفتح في مخطط المعرفة
        const refs = Array.isArray(result.meta.referencedKnowledge) ? result.meta.referencedKnowledge : [];
        if (refs.length && mode === 'commander' && isCommander()) {
          reply.appendChild(el('div', { className: 'card-actions', children: [button('🧠 استند إلى ' + refs.length + ' من المعرفة: اعرضها في المخطط', 'btn-ghost btn-sm', () => openKnowledgeAt(refs[0], refs))] }));
        }
        if (result.meta.conversationId) state.conversationId[mode] = result.meta.conversationId;
        else if (result.meta.saved === false && !state.unsavedWarned[mode]) {
          state.unsavedWarned[mode] = true;
          reply.appendChild(el('span', { className: 'msg-meta', text: '— ' + (result.meta.saveBlockedAr || 'لم تُحفظ هذه المحادثة.') }));
        }
      }
      if (autoSpeakEnabled()) speak(mode, false);
    } catch (err) {
      reply.classList.remove('is-pending');
      reply.classList.add('is-error');
      reply.textContent = '❌ ' + err.message;
    } finally {
      state.busy = false;
      setTimeout(() => {
        const hh = hologram();
        if (hh) hh.setState('IDLE');
      }, 2500);
    }
  }

  // ===================== المحادثات المحفوظة =====================
  function formatDateAr(iso) {
    try {
      return new Date(iso).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return iso;
    }
  }

  async function openConversations(mode) {
    state.conversationsMode = mode;
    const list = $('#conversationsList');
    list.replaceChildren(el('p', { className: 'muted', text: '⏳ جاري التحميل…' }));
    $('#conversationsDialog').showModal();
    let data;
    try {
      data = await api('/api/conversations?mode=' + encodeURIComponent(mode));
    } catch (err) {
      list.replaceChildren(el('p', { className: 'muted', text: err.data && err.data.locked ? '🔒 افتح الخزنة أولاً لعرض المحادثات المحفوظة (محتواها مشفّر بمفتاحها).' : '❌ ' + err.message }));
      return;
    }
    renderConversationList(data.conversations || []);
  }

  function renderConversationList(items) {
    const list = $('#conversationsList');
    $('[data-action="delete-all-conversations"]').hidden = !items.length;
    if (!items.length) {
      list.replaceChildren(el('p', { className: 'muted', text: 'لا توجد محادثات محفوظة بعد.' }));
      return;
    }
    list.replaceChildren(
      ...items.map((c) =>
        el('div', {
          className: 'conv-item' + (state.conversationId[state.conversationsMode] === c.id ? ' is-current' : ''),
          children: [
            el('div', {
              className: 'conv-info',
              children: [
                el('strong', { text: c.title }),
                el('span', { className: 'small muted', text: formatDateAr(c.updatedAt) + ' • ' + Math.ceil(c.messageCount / 2) + ' سؤال' }),
              ],
            }),
            el('div', {
              className: 'conv-actions',
              children: [
                button('فتح', 'btn-primary btn-sm', () => loadConversation(c.id)),
                button('🗑️ حذف', 'btn-ghost btn-sm', () => removeConversation(c)),
              ],
            }),
          ],
        })
      )
    );
  }

  async function loadConversation(id) {
    const mode = state.conversationsMode;
    let conv;
    try {
      conv = await api('/api/conversations/' + encodeURIComponent(id));
    } catch (err) {
      toast('تعذر فتح المحادثة: ' + err.message, 'error');
      return;
    }
    stopSpeaking();
    clearChat(mode);
    const log = chatLog(mode);
    log.replaceChildren();
    conv.messages.forEach((m) => {
      const node = appendMessage(mode, m.role, m.content);
      if (m.role === 'assistant' && m.providerUsed) {
        node.appendChild(el('span', { className: 'msg-meta', text: '— ' + (PROVIDER_NAMES[m.providerUsed] || m.providerUsed) + ' • ' + formatDateAr(m.at) }));
      }
    });
    state.chat[mode] = conv.messages.map((m) => ({ role: m.role, content: m.content }));
    state.conversationId[mode] = conv.id;
    const lastAnswer = conv.messages.filter((m) => m.role === 'assistant').pop();
    state.lastAnswer[mode] = lastAnswer ? lastAnswer.content : '';
    $('#conversationsDialog').close();
    toast('📂 فُتحت المحادثة؛ أي سؤال جديد يُضاف إليها.', 'ok');
  }

  async function removeConversation(c) {
    if (!window.confirm('حذف المحادثة "' + c.title + '" نهائياً؟ لا يمكن التراجع.')) return;
    try {
      await api('/api/conversations/' + encodeURIComponent(c.id) + '/delete', {});
    } catch (err) {
      toast('تعذر الحذف: ' + err.message, 'error');
      return;
    }
    if (state.conversationId[state.conversationsMode] === c.id) state.conversationId[state.conversationsMode] = null;
    toast('🗑️ حُذفت المحادثة.', 'ok');
    openConversations(state.conversationsMode);
  }

  async function removeAllConversations() {
    const mode = state.conversationsMode;
    if (!window.confirm('حذف كل المحادثات المحفوظة' + (mode === 'family' ? ' لوضع العائلة' : ' لغرفة القيادة') + ' نهائياً؟ لا يمكن التراجع.')) return;
    try {
      const r = await api('/api/conversations/delete-all', { mode: mode });
      toast(r.messageAr, 'ok');
    } catch (err) {
      toast('تعذر الحذف: ' + err.message, 'error');
      return;
    }
    state.conversationId[mode] = null;
    openConversations(mode);
  }

  // ===================== النطق الصوتي =====================
  // يُستخدم صوت مطابق للغة الصوت في الإعدادات (العربية افتراضياً) ومثبّت على الجهاز فقط (localService)،
  // فلا يُرسل نص الرد لأي خدمة نطق خارجية. إن لم يوجد صوت عربي لا ننطق بصوت إنجليزي، بل نشرح الحل.
  let voiceWarned = false;

  function speechLang() {
    return (state.app && state.app.voiceLang) || 'ar-SA';
  }

  /** الرد الصوتي التلقائي: تفضيل هذا الجهاز (زر التبديل) وإلا قيمة الإعدادات */
  function autoSpeakEnabled() {
    const pref = store.get('autoSpeak', null);
    return pref === null ? Boolean(state.app && state.app.voiceEnabled) : pref === true;
  }

  function renderAutoSpeakToggles() {
    const on = autoSpeakEnabled();
    $$('[data-action="toggle-auto-speak"]').forEach((b) => {
      b.textContent = on ? '🔊 الرد الصوتي: يعمل' : '🔇 الرد الصوتي: متوقف';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function loadVoices() {
    return new Promise((resolve) => {
      const now = window.speechSynthesis.getVoices();
      if (now.length) return resolve(now);
      const timer = setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1500);
      window.speechSynthesis.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(timer);
          resolve(window.speechSynthesis.getVoices());
        },
        { once: true }
      );
    });
  }

  /** اختيار أفضل صوت محلي بنفس اللغة: المطابق تماماً (ar-SA) أولاً ثم أي لهجة عربية، والطبيعي (Natural) أفضل */
  function pickVoice(voices, lang) {
    const base = lang.split('-')[0].toLowerCase();
    const norm = (v) => String(v.lang || '').replace('_', '-').toLowerCase();
    const candidates = voices.filter((v) => v.localService && (norm(v) === base || norm(v).startsWith(base + '-')));
    if (!candidates.length) return null;
    const score = (v) => (norm(v) === lang.toLowerCase() ? 4 : 0) + (/natural|neural/i.test(v.name) ? 2 : 0) + (v.default ? 1 : 0);
    return candidates.sort((a, b) => score(b) - score(a))[0];
  }

  /** تنظيف الرد للنطق: بلا رموز تنسيق أو كتل كود أو روابط أو رموز تعبيرية */
  function textForSpeech(text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*#_>|~]/g, ' ')
      .replace(/\p{Extended_Pictographic}|️/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** تقسيم النص إلى جمل قصيرة: المتصفحات تقطع النطق الطويل، والجمل تجعل النطق مطابقاً للنص حتى آخره */
  function speechChunks(text, max) {
    const out = [];
    text.split(/(?<=[.!?؟،؛:])\s+/).forEach((sentence) => {
      let rest = sentence;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max / 2) cut = max;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).trim();
      }
      if (rest) out.push(rest);
    });
    // دمج الجمل القصيرة المتتالية لنطق أكثر سلاسة
    return out.reduce((acc, part) => {
      if (acc.length && (acc[acc.length - 1] + ' ' + part).length <= max) acc[acc.length - 1] += ' ' + part;
      else acc.push(part);
      return acc;
    }, []);
  }

  function setSpeakButtons(speaking) {
    $$('[data-action="speak"]').forEach((b) => {
      if (!b.dataset.label) b.dataset.label = b.textContent;
      b.textContent = speaking ? '⏹ إيقاف الصوت' : b.dataset.label;
    });
  }

  // النطق من الخادم (الأفضل): صوت عربي يُولَّد محلياً على الجهاز ويعمل في أي متصفح
  let ttsStatus = null;
  let speakRun = 0; // يزداد مع كل نطق جديد أو إيقاف، فتتوقف الحلقة القديمة
  let currentAudio = null;

  async function serverTts(refresh) {
    if (!ttsStatus || refresh) {
      try {
        ttsStatus = await api('/api/tts/status');
      } catch (e) {
        ttsStatus = { available: false };
      }
    }
    return ttsStatus;
  }

  function isSpeaking() {
    return Boolean(currentAudio) || ('speechSynthesis' in window && window.speechSynthesis.speaking);
  }

  async function fetchSpeech(part) {
    const res = await fetch('/api/tts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: part, speaker: store.get('ttsSpeaker', 'Suad Qasim') }),
    });
    if (!res.ok) {
      let data = {};
      try {
        data = await res.json();
      } catch (e) {
        /* بلا JSON */
      }
      throw new Error(data.error || 'خطأ ' + res.status);
    }
    return URL.createObjectURL(await res.blob());
  }

  function playUrl(url, run) {
    return new Promise((resolve) => {
      if (run !== speakRun) return resolve();
      const audio = new Audio(url);
      currentAudio = audio;
      const h = hologram();
      // نبضات خفيفة أثناء التشغيل (الصوت المولّد لا يرسل حدود الكلمات)
      const pulse = setInterval(() => h && h.pulse(false), 380);
      const done = () => {
        clearInterval(pulse);
        if (currentAudio === audio) currentAudio = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.onpause = done;
      audio.play().catch(done);
    });
  }

  async function speakViaServer(text) {
    const run = ++speakRun;
    const parts = speechChunks(text, (ttsStatus && ttsStatus.maxChars) || 280);
    const h = hologram();
    setSpeakButtons(true);
    if (h) h.setState('SPEAKING');
    try {
      // تجهيز الجملة التالية أثناء تشغيل الحالية، حتى لا تظهر فجوات طويلة
      let next = fetchSpeech(parts[0]);
      for (let i = 0; i < parts.length; i += 1) {
        const url = await next;
        if (run !== speakRun) return URL.revokeObjectURL(url);
        next = i + 1 < parts.length ? fetchSpeech(parts[i + 1]) : null;
        if (next) next.catch(() => undefined);
        await playUrl(url, run);
      }
    } catch (err) {
      if (run === speakRun) {
        ttsStatus = null;
        toast('تعذر النطق: ' + err.message, 'warn', 8000);
      }
    } finally {
      if (run === speakRun) {
        setSpeakButtons(false);
        if (h) h.setState('IDLE');
      }
    }
  }

  function stopSpeaking() {
    speakRun += 1;
    if (currentAudio) currentAudio.pause();
    currentAudio = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeakButtons(false);
    const h = hologram();
    if (h) h.setState('IDLE');
  }

  async function speak(mode, fromButton) {
    if (fromButton && isSpeaking()) return stopSpeaking();
    const text = textForSpeech(state.lastAnswer[mode] || '');
    if (!text) return;
    stopSpeaking();
    const server = await serverTts(fromButton);
    if (server.available) return speakViaServer(text);
    const voice = 'speechSynthesis' in window ? pickVoice(await loadVoices(), speechLang()) : null;
    if (!voice) {
      if (fromButton || !voiceWarned) {
        voiceWarned = true;
        toast(
          'لا يوجد صوت عربي على هذا الجهاز، لذلك لم يُنطق الرد بدل قراءته بصوت إنجليزي. ' +
            'الحل الأسهل: نزّل الصوت العربي المدمج من قسم «🔌 الربط ← الصوت العربي».',
          'warn',
          12000
        );
      }
      return;
    }
    window.speechSynthesis.cancel();
    const h = hologram();
    const parts = speechChunks(text, 180);
    setSpeakButtons(true);
    parts.forEach((part, i) => {
      const utter = new SpeechSynthesisUtterance(part);
      utter.voice = voice;
      utter.lang = voice.lang;
      if (i === 0) utter.onstart = () => h && h.setState('SPEAKING');
      // نبضة خفيفة مع كل كلمة يقرؤها المتصفح
      utter.onboundary = (e) => {
        if (h && e.name === 'word') h.pulse(false);
      };
      if (i === parts.length - 1) {
        utter.onend = () => {
          setSpeakButtons(false);
          if (h) h.setState('IDLE');
        };
      }
      utter.onerror = () => setSpeakButtons(false);
      window.speechSynthesis.speak(utter);
    });
  }

  function voiceInput(mode) {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) {
      toast('المتصفح الحالي لا يدعم الإدخال الصوتي.', 'warn');
      return;
    }
    const rec = new Rec();
    rec.lang = (state.app && state.app.voiceLang) || 'ar-SA';
    const h = hologram();
    if (h) h.setState('LISTENING');
    rec.onresult = (e) => ask(mode, e.results[0][0].transcript);
    rec.onerror = () => {
      if (h) h.setState('IDLE');
      toast('لم يُلتقط الصوت. حاول مجدداً.', 'warn');
    };
    rec.start();
  }

  async function refreshProviders() {
    const line = $('#providerLine');
    try {
      const data = await api('/api/assistant/providers');
      line.textContent =
        'المزوّدون بالترتيب: ' +
        data.providers.map((p) => (PROVIDER_NAMES[p.id] || p.id) + (p.available ? ' ✓' : ' ✗')).join(' ← ') +
        (data.vaultUnlocked || !data.providers.some((p) => p.id === 'claude' || p.id === 'gemini') ? '' : ' • افتح الخزنة لاستخدام مفاتيح API المحفوظة فيها');
    } catch (e) {
      line.textContent = '';
    }
  }

  // ===================== دليل الربط =====================
  async function renderVoiceStatus(refresh) {
    const status = await serverTts(refresh);
    const badge = $('#voiceStatusBadge');
    const text = $('#voiceStatusText');
    if (!badge || !text) return;
    const engines = { xtts: 'XTTS-v2 (عالي الجودة)', piper: 'الصوت العربي المدمج Kareem', windows: 'صوت Windows العربي', macos: 'صوت macOS العربي' };
    const picker = $('#voiceSpeakerRow');
    if (picker) picker.hidden = !(status.speakers && status.speakers.length);
    if (status.speakers && status.speakers.length) {
      const select = $('#voiceSpeaker');
      const current = store.get('ttsSpeaker', status.speakers[0]);
      select.replaceChildren(...status.speakers.map((s) => el('option', { text: s, attrs: { value: s } })));
      select.value = status.speakers.indexOf(current) >= 0 ? current : status.speakers[0];
    }
    if (status.available) {
      badge.className = 'badge ok';
      badge.textContent = '✓ جاهز';
      let line = 'يعمل الآن: ' + (engines[status.engine] || status.engine) + (status.voiceName && status.engine !== 'xtts' ? ' (' + status.voiceName + ')' : '') + '.';
      if (status.engine === 'xtts' && status.workerState !== 'ready') {
        line += ' النموذج يُحمَّل في الخلفية (نحو نصف دقيقة)' + (status.fallbackEngine ? '، وحتى ذلك الحين يُستخدم ' + (engines[status.fallbackEngine] || status.fallbackEngine) : '') + '.';
      }
      text.textContent = line;
    } else {
      badge.className = 'badge warn';
      badge.textContent = '✗ لا يوجد صوت عربي';
      text.textContent = status.reasonAr || 'لا يوجد صوت عربي على هذا الجهاز.';
    }
    const installBtn = $('[data-action="install-arabic-voice"]');
    showWhen(installBtn, !(status.engine === 'piper' || status.fallbackEngine === 'piper' || status.engine === 'macos' || status.fallbackEngine === 'macos'));
  }

  async function loadProvidersGuide() {
    renderVoiceStatus(true);
    let data;
    try {
      data = await api('/api/assistant/providers');
    } catch (e) {
      return;
    }
    $$('.connect-card').forEach((card) => {
      const badge = $('[data-status]', card);
      const p = data.providers.find((x) => x.id === card.dataset.provider);
      if (!p) {
        badge.className = 'badge';
        badge.textContent = 'خارج ترتيب المزوّدين';
        badge.title = 'غيّر "الوضع" في الإعدادات ليُستخدم هذا المزوّد';
      } else if (p.available) {
        badge.className = 'badge ok';
        badge.textContent = '✓ جاهز';
        badge.title = '';
      } else {
        badge.className = 'badge warn';
        badge.textContent = p.configured ? '✗ غير متاح' : '✗ غير مهيّأ';
        badge.title = p.reasonAr || '';
      }
    });
  }

  async function testProvider(btn) {
    const card = btn.closest('.connect-card');
    const box = $('[data-result]', card);
    box.hidden = false;
    box.className = 'report';
    box.textContent = '⏳ جارٍ الاختبار…';
    const done = await busy(btn, async () => {
      const r = await api('/api/assistant/test', { provider: btn.dataset.provider });
      box.className = 'report ' + (r.ok ? 'ok' : 'fail');
      box.textContent = r.ok
        ? '✅ يعمل. النموذج: ' + r.model + ' — الزمن: ' + (r.latencyMs / 1000).toFixed(1) + ' ث' + (r.replyPreview ? '\nالرد: ' + r.replyPreview : '')
        : '❌ لم ينجح الاتصال (' + r.model + ').\nالسبب: ' + r.reasonAr + '\nالحل المقترح: ' + r.hintAr;
      loadProvidersGuide();
      return true;
    });
    if (!done) box.hidden = true;
  }

  // ===================== معالجات النماذج =====================
  const formHandlers = {
    async 'sync-settings'(form, btn) {
      await busy(btn, async () => {
        try {
          const r = await api('/api/sync/settings', { enabled: form.elements.enabled.checked, folder: form.elements.folder.value });
          toast(r.messageAr, 'ok');
          await loadSync();
        } catch (err) {
          if (err.data && err.data.needsSettingsAuth) {
            toast('أدخل كلمة المرور الرئيسية ثم أعد الحفظ.', 'warn');
            openSettingsAuth();
            return;
          }
          throw err;
        }
      });
    },
    async chat(form) {
      await ask(form.dataset.mode);
    },
    async 'add-project'(form, btn) {
      await busy(btn, async () => {
        const data = await api('/api/projects/add', formData(form));
        showReport('#projectsReport', data.messageAr);
        form.reset();
        form.hidden = true;
        await loadState();
      });
    },
    async 'project-edit'(form, btn) {
      await busy(btn, async () => {
        const data = await api('/api/projects/' + encodeURIComponent(state.projectId) + '/update', formData(form));
        $('#projectDialog').close();
        toast(data.messageAr, 'ok');
        await openProject(state.projectId);
        loadState();
      });
    },
    async setup(form, btn) {
      const v = formData(form);
      if (v.masterPassword !== v.confirmPassword) {
        toast('تأكيد كلمة المرور غير مطابق.', 'error');
        return;
      }
      await busy(btn, async () => {
        const data = await api('/api/vault/setup', v);
        form.reset();
        updateStrength('');
        await refreshVault();
        refreshProviders();
        revealEmergencyKey(data.emergencyRecoveryKey, data.messageAr);
      });
    },
    async unlock(form, btn) {
      await busy(btn, async () => {
        let r;
        try {
          r = await api('/api/vault/unlock', formData(form));
        } catch (err) {
          // 3.5.0: المصادقة الثنائية: يظهر حقل الرمز، وتبقى كلمة المرور مكتوبة
          if (err.data && err.data.twoFactorRequired) {
            const firstAsk = $('#twoFactorField').hidden || !form.elements.twoFactorCode.value;
            $('#twoFactorField').hidden = false;
            form.elements.twoFactorCode.value = '';
            form.elements.twoFactorCode.focus();
            // الطلب الأول للرمز خطوة عادية لا خطأ
            if (firstAsk) {
              toast('🔐 ' + err.message, 'ok', 8000);
              return;
            }
          }
          throw err;
        }
        form.reset();
        $('#twoFactorField').hidden = true;
        if (r.twoFactorNoteAr) toast(r.twoFactorNoteAr, 'warn', 12000);
        await refreshVault();
        refreshProviders();
        toast('🔓 فُتحت الخزنة.', 'ok');
        if (r.syncMessageAr) {
          toast(r.syncMessageAr, 'ok', 9000);
          await loadState();
        }
        loadSync();
      });
    },
    async 'family-unlock'(form, btn) {
      await busy(btn, async () => {
        await api('/api/vault/unlock', formData(form));
        form.reset();
        await refreshVault();
        toast('🔓 فُتحت الخزنة.', 'ok');
      });
    },
    async '2fa-begin'(form, btn) {
      await busy(btn, async () => {
        const d = await api('/api/2fa/setup/begin', formData(form));
        form.reset();
        $('#twoFactorSecret').textContent = d.secretBase32;
        $('#twoFactorQr').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(d.qrSvg);
        $('#twoFactorSetup').hidden = false;
        $('#twoFactorBegin').hidden = true;
        $('[data-form="2fa-finish"]').elements.code.focus();
      });
    },
    async '2fa-finish'(form, btn) {
      await busy(btn, async () => {
        const d = await api('/api/2fa/setup/finish', formData(form));
        form.reset();
        $('#twoFactorSetup').hidden = true;
        $('#twoFactorSecret').textContent = '';
        $('#twoFactorQr').removeAttribute('src');
        toast(d.messageAr, 'ok', 10000);
        showBackupCodes(d);
        await loadTwoFactor();
      });
    },
    async '2fa-codes'(form, btn) {
      const disable = Boolean(btn && btn.dataset.twofactorDisable === '1');
      if (disable && !window.confirm('تعطيل المصادقة الثنائية على كل الأجهزة؟ ستفتح الخزنة بكلمة المرور وحدها.')) return;
      if (!disable && !window.confirm('إنشاء رموز احتياطية جديدة يُبطل القديمة كلها. متابعة؟')) return;
      await busy(btn, async () => {
        const d = await api(disable ? '/api/2fa/disable' : '/api/2fa/backup-codes', formData(form));
        form.reset();
        toast(d.messageAr, 'ok', 10000);
        if (disable) $('#twoFactorCodes').hidden = true;
        else showBackupCodes(d);
        await loadTwoFactor();
      });
    },
    async 'passkey-register'(form, btn) {
      if (!probeHostOk()) return;
      await busy(btn, async () => {
        const f = formData(form);
        const opt = await api('/api/passkeys/register/begin', { masterPassword: f.masterPassword, label: f.label });
        form.reset();
        const salt = b64uToBytes(opt.prfSalt);
        let cred;
        let a;
        try {
          cred = await navigator.credentials.create({
            publicKey: {
              rp: { name: 'Second Brain', id: opt.rpId },
              user: { id: b64uToBytes(opt.userId), name: 'second-brain', displayName: 'Second Brain — الخزنة' },
              challenge: b64uToBytes(opt.createChallenge),
              pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 },
              ],
              authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
              attestation: 'none',
              excludeCredentials: opt.excludeCredentialIds.map((id) => ({ type: 'public-key', id: b64uToBytes(id) })),
              timeout: 120000,
              extensions: { prf: { eval: { first: salt } } },
            },
          });
        } catch (err) {
          throw new Error(err && err.name === 'NotAllowedError' ? 'أُلغي التسجيل أو انتهى وقته.' : err && err.name === 'InvalidStateError' ? 'هذا الـ Passkey مسجّل على هذا الجهاز بالفعل.' : 'تعذّر إنشاء الـ Passkey: ' + ((err && err.name) || ''));
        }
        const ce = cred.getClientExtensionResults() || {};
        if (ce.prf && ce.prf.enabled === false) {
          throw new Error('المكان الذي اخترته لا يدعم PRF (مثل Windows Hello على Windows 10)، فلا يفتح الخزنة. أعد التسجيل واختر «مدير كلمات المرور في Google»، واحذف الـ Passkey الذي أُنشئ للتو من مدير كلمات المرور.');
        }
        try {
          a = await navigator.credentials.get({
            publicKey: {
              challenge: b64uToBytes(opt.getChallenge),
              rpId: opt.rpId,
              allowCredentials: [{ type: 'public-key', id: cred.rawId }],
              userVerification: 'required',
              timeout: 120000,
              extensions: { prf: { eval: { first: salt } } },
            },
          });
        } catch (err) {
          throw new Error('أُنشئ الـ Passkey، لكن أُلغي التحقق الثاني. احذفه من مدير كلمات المرور ثم أعد التسجيل.');
        }
        const first = prfFirst(a);
        if (!first) throw new Error('الـ Passkey لم يُعطِ سرّ PRF، فلا يفتح الخزنة. احذفه من مدير كلمات المرور، وأعد التسجيل باختيار «مدير كلمات المرور في Google» أو Touch ID.');
        const data = await api('/api/passkeys/register/finish', {
          token: opt.token,
          attestationObject: bytesToB64u(cred.response.attestationObject),
          clientDataJSON: bytesToB64u(cred.response.clientDataJSON),
          assertion: {
            credentialId: bytesToB64u(a.rawId),
            authenticatorData: bytesToB64u(a.response.authenticatorData),
            clientDataJSON: bytesToB64u(a.response.clientDataJSON),
            signature: bytesToB64u(a.response.signature),
          },
          prfOutput: bytesToB64u(first),
        });
        first.fill(0);
        toast(data.messageAr, 'ok', 9000);
        await loadPasskeys();
      });
    },
    async 'portal-item'(form, btn) {
      await busy(btn, async () => {
        const data = await api('/api/family/portal/item', formData(form));
        $('#portalDialog').close();
        toast(data.messageAr, 'ok');
        await refreshVault();
      });
    },
    async 'family-log-note'(form, btn) {
      await busy(btn, async () => {
        const data = await api('/api/family/log', formData(form));
        form.reset();
        toast(data.messageAr, 'ok');
        await loadPortal();
      });
    },
    async secret(form, btn) {
      await busy(btn, async () => {
        const data = await api('/api/vault/secrets', formData(form));
        $('#secretDialog').close();
        toast(data.messageAr, 'ok');
        await refreshVault();
      });
    },
    async 'ai-key'(form, btn) {
      await busy(btn, async () => {
        const data = await api('/api/assistant/keys', formData(form));
        form.elements.apiKey.value = '';
        toast(data.messageAr, 'ok');
        await refreshVault();
        refreshProviders();
      });
    },
    async kit(form, btn) {
      const win = window.open('', '_blank');
      await busy(btn, async () => {
        try {
          const data = await api('/api/emergency/kit', formData(form));
          if (win) win.location.href = data.printUrl;
          else window.location.href = data.printUrl;
          toast('✅ فُتح كتيب الطوارئ في نافذة جديدة. اطبعه ثم أغلقها.', 'ok');
        } catch (err) {
          if (win) win.close();
          throw err;
        }
      });
    },
    async 'restore-drill'(form, btn) {
      const r = await busy(btn, () => api('/api/emergency/restore-drill', { key: form.elements.key.value }));
      form.elements.key.value = '';
      if (!r) return;
      toast(r.messageAr, r.report.ok ? 'ok' : 'error', 8000);
      const box = $('#drillReport');
      box.hidden = false;
      const rep = r.report;
      const lines = rep.checks.map((c) => el('li', { text: (c.ok ? '✅ ' : '❌ ') + c.nameAr + ': ' + c.detailAr }));
      const cmp = rep.comparedWithLive;
      box.replaceChildren(
        ...[
        el('p', { className: 'small', text: 'النسخة: ' + rep.backupFile + ' (' + formatDateAr(rep.backupCreatedAt) + (rep.backupAgeDays >= 0 ? '، عمرها ' + rep.backupAgeDays + ' يوماً' : '') + ') · ' + ({ local: 'من مجلد النسخ على هذا الجهاز', extra: 'من المجلد الإضافي', drive: 'من مجلد Backups على Google Drive' }[rep.location] || '') + ' · ' + rep.filesCount + ' ملفاً · ' + Math.round(rep.durationMs / 100) / 10 + ' ثانية' }),
        rep.ageWarningAr ? el('p', { className: 'small warn', text: rep.ageWarningAr }) : null,
        el('ul', { className: 'list compact', children: lines }),
        cmp ? el('p', { className: 'small muted', text: 'مقارنة مع هذا الجهاز الآن (معلومة لا خطأ، فالنسخة قد تكون أقدم): ' + cmp.obsidianFilesOnlyLive + ' ملف Obsidian، و' + cmp.conversationsOnlyLive + ' محادثة، و' + cmp.memoryOnlyLive + ' سجل ذاكرة موجودة هنا وليست في النسخة.' }) : null,
        ].filter(Boolean) // ISS-031: replaceChildren يكتب null كنص «null»
      );
    },
    async 'change-password'(form, btn) {
      await busy(btn, async () => {
        const data = await api('/api/vault/change-password', formData(form));
        form.reset();
        toast(data.messageAr, 'ok');
      });
    },
    async 'family-migrate'(form, btn) {
      const ids = $$('[data-family-pick]', form).filter((i) => i.checked).map((i) => i.value);
      if (!window.confirm('سيُولَّد مفتاح طوارئ جديد، ولن يفتح المفتاح المطبوع الحالي هذه الخزنة بعد الآن. للعائلة: ' + ids.length + ' سرّاً. متابعة؟')) return;
      await busy(btn, async () => {
        const data = await api('/api/vault/family/migrate', Object.assign(formData(form), { secretIds: ids }));
        form.reset();
        revealEmergencyKey(data.emergencyRecoveryKey, data.messageAr);
        await refreshVault();
      });
    },
    async 'family-old-delete'(form, btn) {
      if (!window.confirm('ستُحذف النسخ القديمة المعروضة نهائياً (من هذا الجهاز ومن Drive). النسخة الجديدة بالصيغة 3 تبقى. متابعة؟')) return;
      await busy(btn, async () => {
        const data = await api('/api/vault/family/old-copies/delete', formData(form));
        form.reset();
        toast(data.messageAr, data.failed && data.failed.length ? 'warn' : 'ok', 10000);
        await loadFamilyVault();
      });
    },
    async rotate(form, btn) {
      if (!window.confirm('سيُبطل هذا مفتاح الطوارئ المطبوع حالياً. متابعة؟')) return;
      await busy(btn, async () => {
        const data = await api('/api/vault/rotate-emergency-key', formData(form));
        form.reset();
        revealEmergencyKey(data.emergencyRecoveryKey, data.messageAr);
        // 3.9.4 (ISS-048): بطاقة الخزنة العائلية تعرض النسخ القديمة التي يفتحها المفتاح السابق
        await refreshVault();
      });
    },
    async restore(form, btn) {
      const dryRun = !btn || btn.dataset.dryRun !== 'false';
      await busy(btn, async () => {
        const payload = Object.assign(formData(form), { dryRun: dryRun });
        const data = await api('/api/emergency/restore', payload);
        const head = dryRun
          ? '👁️ النسخة سليمة وتُفتح بهذا المفتاح. تاريخها: ' + data.createdAt + ' — عدد الملفات: ' + data.filesCount
          : '✅ تمت الاستعادة إلى: ' + data.targetDir + ' — عدد الملفات: ' + data.filesCount;
        showReport('#restoreReport', head + '\n' + data.files.slice(0, 15).join('\n'));
      });
    },
    async settings(form, btn) {
      await busy(btn, async () => {
        try {
          const data = await api('/api/settings', collectSettings(form));
          state.settings = data.settings;
          toast(data.messageAr, 'ok');
          await loadState();
          refreshProviders();
        } catch (err) {
          // انتهت صلاحية الإعدادات (5 دقائق): نطلب كلمة المرور ثم يعيد المستخدم الحفظ
          if (err.data && err.data.needsSettingsAuth) {
            toast('انتهت مدة صلاحية الإعدادات. أدخل كلمة المرور ثم اضغط حفظ مجدداً.', 'warn');
            openSettingsAuth();
            return;
          }
          throw err;
        }
      });
    },
    async 'settings-auth'(form, btn) {
      await busy(btn, async () => {
        let r;
        try {
          r = await api('/api/settings/auth', formData(form));
        } catch (err) {
          // 3.9.3 (ISS-047): فتح جلسة قائد جديدة من هنا يطلب الرمز الثاني كما في شاشة الفتح
          if (err.data && err.data.twoFactorRequired) {
            const firstAsk = $('#settingsTwoFactorField').hidden || !form.elements.twoFactorCode.value;
            $('#settingsTwoFactorField').hidden = false;
            form.elements.twoFactorCode.value = '';
            form.elements.twoFactorCode.focus();
            if (firstAsk) {
              toast('🔐 ' + err.message, 'ok', 8000);
              return;
            }
          }
          throw err;
        }
        form.reset();
        $('#settingsTwoFactorField').hidden = true;
        if (r && r.twoFactorNoteAr) toast(r.twoFactorNoteAr, 'warn', 12000);
        $('#authDialog').close();
        await refreshVault();
        await loadSettings();
      });
    },
  };

  // ===================== الأزرار العامة =====================
  const actions = {
    mode: (b) => setMode(b.dataset.mode),
    view: (b) => setView(b.dataset.view),
    'toggle-sound': (b) => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      applySound(on);
      store.set('sound', on);
    },
    'clear-chat': (b) => clearChat(b.dataset.mode),
    'portal-new': (b) => openPortalDialog(b.dataset.category),
    'passkey-probe': (b) => runPasskeyProbe(b),
    'passkey-unlock': (b) => passkeyUnlock(b),
    'scan-key': (b) => scanKeyIntoForm(b),
    'open-conversations': (b) => openConversations(b.dataset.mode),
    'sync-refresh': () => loadSync(),
    'sync-now': (b) => syncAction(b, '/api/sync/now'),
    'restart-server': (b) => restartServer(b),
    'sync-held': (b) => {
      const confirmDelete = b.dataset.choice === 'confirm';
      if (confirmDelete && !window.confirm('سيُحذف كل ما في القائمة من كل الأجهزة (ويبقى في السلة 30 يوماً). متابعة؟')) return;
      syncAction(b, '/api/sync/held/resolve', { direction: b.dataset.direction, action: b.dataset.choice });
    },
    'sync-resolve': (b) => {
      const other = b.dataset.choice === 'other';
      if (other && !window.confirm('ستُعتمد النسخة الأخرى، وتُنقل الحالية إلى السلة 30 يوماً. متابعة؟')) return;
      syncAction(b, '/api/sync/conflicts/resolve', { id: b.dataset.id, choice: b.dataset.choice });
    },
    'sync-restore': async (b) => {
      await syncAction(b, '/api/sync/trash/restore', { id: b.dataset.id });
      await loadSyncTrash();
    },
    'project-locate': async (b) => {
      const d = state.projectDetails;
      if (!d) return;
      const target = window.prompt('المسار الكامل لمجلد «' + d.project.name + '» على هذا الجهاز (اتركه فارغاً لإلغاء التحديد المحلي):', d.project.pathExists ? d.project.path : '');
      if (target === null) return;
      const r = await busy(b, () => api('/api/projects/' + encodeURIComponent(d.project.id) + '/locate', { path: target.trim() }));
      if (!r) return;
      toast(r.messageAr, 'ok');
      await loadState();
      openProject(d.project.id);
    },
    'test-voice': () => {
      state.lastAnswer.voiceTest = 'مرحباً، هذا اختبار الصوت العربي في العقل الثاني. إن سمعت هذه الجملة بوضوح فالنطق يعمل.';
      speak('voiceTest', true);
    },
    'install-arabic-voice': async (b) => {
      if (!window.confirm('سيُنزَّل محرك النطق Piper والصوت العربي «Kareem» (نحو 85MB) من GitHub و Hugging Face إلى مجلد vendor داخل المشروع. متابعة؟')) return;
      toast('⏳ جاري التنزيل… قد يستغرق دقيقة أو أكثر حسب سرعة الإنترنت.', 'ok', 8000);
      await busy(b, async () => {
        const r = await api('/api/tts/install', {});
        toast(r.messageAr, 'ok');
        ttsStatus = r.status;
        renderVoiceStatus(false);
      });
    },
    'delete-all-conversations': () => removeAllConversations(),
    voice: (b) => voiceInput(b.dataset.mode),
    speak: (b) => speak(b.dataset.mode, true),
    'toggle-auto-speak': () => {
      const on = !autoSpeakEnabled();
      store.set('autoSpeak', on);
      renderAutoSpeakToggles();
      if (!on) stopSpeaking();
      toast(on ? '🔊 سيُنطق كل رد تلقائياً.' : '🔇 أُوقف الرد الصوتي التلقائي.', 'ok');
    },
    preset: (b) => ask('family', b.dataset.q),
    rescan: (b) => rescan(b),
    'toggle-add-project': () => {
      const f = $('#addProjectForm');
      f.hidden = !f.hidden;
      if (!f.hidden) f.elements.name.focus();
    },
    harvest: (b) =>
      busy(b, async () => {
        const data = await api('/api/memory/harvest', {});
        showReport('#memoryReport', data.messageAr);
        await loadState();
      }),
    backup: (b) =>
      busy(b, async () => {
        const data = await api('/api/emergency/backup', {});
        toast(data.messageAr, 'ok');
        await loadBackups();
      }),
    lock: async () => {
      try {
        await api('/api/vault/lock', {});
      } catch (e) {
        /* لا شيء */
      }
      await refreshVault();
      refreshProviders();
      toast('🔒 قُفلت الخزنة.', 'ok');
    },
    'new-secret': () => openSecretDialog(null),
    'close-dialog': (b) => {
      const d = b.closest('dialog');
      if (d) d.close();
    },
    'back-to-projects': () => setView('projects'),
    'knowledge-to-review': () => setView('memory'),
    'graph-zoom': (b) => kv.graph && kv.graph.zoomBy(Number(b.dataset.factor) || 1),
    'graph-reset': () => kv.graph && kv.graph.reset(),
    'test-provider': (b) => testProvider(b),
    'refresh-providers-guide': () => {
      loadProvidersGuide();
      loadMcpTools();
    },
    'dev-reset': async (b) => {
      const m = state.maintenance;
      if (!m) return;
      const confirm = askPhrase('سيُنقل كل شيء شخصي (الخزنة، الإعدادات، المشاريع، الذاكرة، السجلات) إلى السلة، ويبدأ البرنامج من جديد كأول تشغيل.', m.phrases.reset);
      if (confirm === null) return;
      const data = await maintenanceCall(b, '/api/maintenance/reset', { confirm });
      if (data) reloadAfterMaintenance(data.messageAr);
    },
    'dev-restore': async (b) => {
      if (!window.confirm('استرجاع آخر حالة من السلة؟ الحالة الحالية لن تُحذف بل تُحفظ في السلة أولاً.')) return;
      const data = await maintenanceCall(b, '/api/maintenance/restore-last', {});
      if (data) reloadAfterMaintenance(data.messageAr);
    },
    'dev-empty-trash': async (b) => {
      const m = state.maintenance;
      if (!m) return;
      const confirm = askPhrase('⚠️ حذف نهائي لا رجعة فيه لكل ما في السلة.', m.phrases.emptyTrash);
      if (confirm === null) return;
      const data = await maintenanceCall(b, '/api/maintenance/empty-trash', { confirm });
      if (data) {
        toast(data.messageAr, 'ok');
        loadMaintenance();
      }
    },
    'dev-finalize': async (b) => {
      const m = state.maintenance;
      if (!m) return;
      const confirm = askPhrase('الاعتماد النهائي يُطفئ وضع التطوير ولا يمكن التراجع عنه من البرنامج. زر التصفير سيختفي.', m.phrases.finalize);
      if (confirm === null) return;
      const data = await maintenanceCall(b, '/api/maintenance/finalize', { confirm });
      if (data) {
        toast(data.messageAr, 'ok', 7000);
        loadMaintenance();
      }
    },
    'project-open': (b) =>
      busy(b, async () => {
        await api('/api/projects/' + encodeURIComponent(state.projectId) + '/open', { target: b.dataset.target });
        toast(b.dataset.target === 'vscode' ? '🧑‍💻 فُتح المشروع في VS Code.' : '📂 فُتح مجلد المشروع.', 'ok');
      }),
    'project-rescan': (b) =>
      busy(b, async () => {
        await api('/api/projects/rescan', {});
        await openProject(state.projectId);
        toast('✅ أُعيد فحص المشروع.', 'ok');
        loadState();
      }),
    'project-edit': () => openProjectDialog(),
    'project-remove': (b) => {
      const p = state.projectDetails && state.projectDetails.project;
      if (!p || !window.confirm('إيقاف مراقبة (' + p.name + ')؟ وثائقه في Obsidian تبقى كما هي، ويمكنك إضافته لاحقاً.')) return;
      busy(b, async () => {
        const data = await api('/api/projects/' + encodeURIComponent(p.id) + '/remove', {});
        toast(data.messageAr, 'ok');
        await loadState();
        setView('projects');
      });
    },
    'open-settings-auth': () => openSettingsAuth(),
    'extract-start': async (b) => {
      await busy(b, async () => {
        const d = await api('/api/knowledge/extract/start', {});
        toast(d.messageAr, 'ok', 8000);
        renderExtractionJob(d.job);
        if (d.job.running && !extractPoll) extractPoll = setInterval(pollExtraction, 2000);
      });
    },
    'extract-cancel': async () => {
      const d = await api('/api/knowledge/extract/cancel', {});
      toast(d.messageAr, 'ok');
    },
    'cancel-settings-auth': () => {
      $('#authDialog').close();
      setView('command');
    },
  };

  function applySound(on) {
    const b = $('#soundToggle');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '🔊' : '🔇';
    const h = hologram();
    if (h) h.setSound(on);
  }

  // ===================== ربط الأحداث =====================
  function bindEvents() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target || target.tagName === 'FORM') return;
      const fn = actions[target.dataset.action];
      if (fn) {
        e.preventDefault();
        fn(target);
      }
    });

    document.addEventListener('submit', (e) => {
      const form = e.target.closest('[data-form]');
      if (!form) return;
      e.preventDefault();
      const handler = formHandlers[form.dataset.form];
      if (handler) handler(form, e.submitter || $('[type="submit"]', form));
    });

    $$('.chat-form textarea').forEach((ta) => {
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          ta.form.requestSubmit();
        }
      });
    });

    $('[data-form="setup"]').elements.masterPassword.addEventListener('input', (e) => updateStrength(e.target.value));
    $('#secretSearch').addEventListener('input', renderSecrets);
    // 4.1.0: تصفية المخطط وبحثه
    $('#knowledgeProject').addEventListener('change', loadKnowledgeView);
    $('#knowledgeType').addEventListener('change', loadKnowledgeView);
    $('#knowledgeSearch').addEventListener('input', applyKnowledgeSearch);
    $('#knowledgeSearch').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const ids = applyKnowledgeSearch();
      if (ids.length) openKnowledgeNode(ids[0]);
    });
    $('#secretFilter').addEventListener('change', renderSecrets);
    // 4.0.2: مزوّد الاستخراج (يُحفظ لكل جهاز فوراً)
    $('#extractProvider').addEventListener('change', async (e) => {
      const sel = e.currentTarget;
      try {
        const d = await api('/api/knowledge/extract/provider', { choice: sel.value });
        toast(d.messageAr, 'ok');
      } catch (err) {
        toast('❌ ' + err.message, 'error');
        loadExtraction();
      }
    });
    // 4.0.1: النسخة المحلية من مفتاح المعرفة لأدوات الذكاء على هذا الجهاز
    $('#knowledgeDeviceKey').addEventListener('change', async (e) => {
      const input = e.currentTarget;
      input.disabled = true;
      try {
        const d = await api('/api/knowledge/device-key', { enabled: input.checked });
        toast(d.messageAr, 'ok', 8000);
      } catch (err) {
        input.checked = !input.checked;
        toast('❌ ' + err.message, 'error');
      } finally {
        input.disabled = false;
      }
    });
    $('#voiceSpeaker').addEventListener('change', (e) => {
      store.set('ttsSpeaker', e.target.value);
      toast('🔊 الصوت المختار: ' + e.target.value, 'ok');
    });
    $('#memorySearch').addEventListener('input', renderMemory);

    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === '/' && !typing && state.mode === 'commander') {
        e.preventDefault();
        setView('command');
        $('#chatInput').focus();
      }
    });

    document.addEventListener('visibilitychange', () => {
      updateHologramVisibility();
      if (!document.hidden) refreshVault();
    });

    $('#coreCanvas').addEventListener('click', () => {
      const h = hologram();
      if (h) h.pulse(true);
    });
  }

  // ===================== التشغيل =====================
  function init() {
    bindEvents();
    applySound(store.get('sound', false));
    setView(store.get('view', 'command'));
    setMode('commander');
    loadState();
    refreshVault().then(refreshProviders);
    loadSync();
    setInterval(() => {
      if (!document.hidden) refreshVault();
    }, 30000);
    checkRuntimeVersion();
    setInterval(() => {
      if (!document.hidden) {
        loadSync();
        checkRuntimeVersion();
      }
    }, 60000);
    setInterval(updateAutoLockBadge, 15000);
    setupKeyScanner();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
