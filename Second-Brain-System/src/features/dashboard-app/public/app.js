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
  };
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
    if (view === 'connect') loadProvidersGuide();
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

    $('#projectBody').replaceChildren(
      projectSection('📌 ما هو؟', [
        tags,
        el('p', { text: p.descriptionAr || '—' }),
        el('p', { className: 'small', children: [el('strong', { text: 'للعائلة: ' }), el('span', { text: p.wifeSummaryAr || '—' })] }),
        el('p', { className: 'small', children: [el('strong', { text: '💰 الدخل: ' }), el('span', { text: p.monthlyIncome || '—' }), el('strong', { text: '  🧾 الفواتير: ' }), el('span', { text: p.billingNotes || '—' })] }),
      ]),
      projectSection('🧭 الخلاصة: ماذا يخدم وكيف يعمل', [summaryBox, el('div', { className: 'card-actions', children: [genBtn] })]),
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
    try {
      state.vault = await api('/api/vault/status');
    } catch (e) {
      return;
    }
    state.autoLockAt = state.vault.unlocked ? Date.now() + (state.vault.secondsUntilAutoLock || 0) * 1000 : null;
    renderVaultChrome();
    if (state.vault.unlocked) await loadSecrets();
    else {
      state.secrets = [];
      renderSecrets();
    }
  }

  function renderVaultChrome() {
    const v = state.vault;
    $('#vaultSetup').hidden = v.exists;
    $('#vaultUnlock').hidden = !v.exists || v.unlocked;
    $('#vaultOpen').hidden = !v.unlocked;
    $('#vaultToolbar').hidden = !v.unlocked;
    $$('[data-commander-only]').forEach((n) => (n.hidden = !isCommander()));

    const chip = $('#chipVault');
    chip.textContent = !v.exists ? 'غير مُنشأة' : v.unlocked ? 'مفتوحة' : 'مقفلة';
    $('#chipVaultWrap').classList.toggle('is-open', v.unlocked);
    $('#familyVaultStatus').textContent = !v.exists
      ? 'لم تُنشأ الخزنة على هذا الجهاز. إن كان لديكِ ملف نسخة احتياطية استخدمي "استعادة نسخة احتياطية" بالأسفل.'
      : v.unlocked
        ? '🔓 الخزنة مفتوحة — ' + v.secretsCount + ' عنصر.'
        : '🔒 الخزنة مقفلة.';
    updateAutoLockBadge();
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
    card.appendChild(el('div', { className: 'secret-head', children: [el('h3', { text: s.title }), el('span', { className: 'badge', text: CATEGORY_LABELS[s.category] || s.category })] }));

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
    const log = chatLog(mode);
    log.replaceChildren();
    if (mode === 'commander') log.appendChild(el('p', { className: 'chat-empty muted', text: 'بدأت محادثة جديدة.' }));
  }

  async function streamAssistant(question, mode, onText, onReset) {
    const res = await fetch('/api/assistant/stream', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question, mode: mode === 'family' ? 'wife_emergency' : 'commander', history: state.chat[mode].slice(-12) }),
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
      }
      if (state.app && state.app.voiceEnabled) speak(mode);
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

  function speak(mode) {
    const text = state.lastAnswer[mode];
    if (!text || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text.replace(/[*#_`>|]/g, ''));
    utter.lang = (state.app && state.app.voiceLang) || 'ar-SA';
    const h = hologram();
    utter.onstart = () => h && h.setState('SPEAKING');
    // نبضة خفيفة مع كل كلمة يقرؤها المتصفح
    utter.onboundary = (e) => {
      if (h && e.name === 'word') h.pulse(false);
    };
    utter.onend = () => h && h.setState('IDLE');
    window.speechSynthesis.speak(utter);
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
  async function loadProvidersGuide() {
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
        await api('/api/vault/unlock', formData(form));
        form.reset();
        await refreshVault();
        refreshProviders();
        toast('🔓 فُتحت الخزنة.', 'ok');
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
    async 'change-password'(form, btn) {
      await busy(btn, async () => {
        const data = await api('/api/vault/change-password', formData(form));
        form.reset();
        toast(data.messageAr, 'ok');
      });
    },
    async rotate(form, btn) {
      if (!window.confirm('سيُبطل هذا مفتاح الطوارئ المطبوع حالياً. متابعة؟')) return;
      await busy(btn, async () => {
        const data = await api('/api/vault/rotate-emergency-key', formData(form));
        form.reset();
        revealEmergencyKey(data.emergencyRecoveryKey, data.messageAr);
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
        await api('/api/settings/auth', formData(form));
        form.reset();
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
    voice: (b) => voiceInput(b.dataset.mode),
    speak: (b) => speak(b.dataset.mode),
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
    'test-provider': (b) => testProvider(b),
    'refresh-providers-guide': () => loadProvidersGuide(),
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
    $('#secretFilter').addEventListener('change', renderSecrets);
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
    setInterval(() => {
      if (!document.hidden) refreshVault();
    }, 30000);
    setInterval(updateAutoLockBadge, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
