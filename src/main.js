import { agents } from './agents.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
// Support pour Tauri v2 : le plugin dialog peut être sur .dialog ou .pluginDialog
const dialog = window.__TAURI__.dialog || window.__TAURI__.pluginDialog;
const open = dialog ? dialog.open : null;

let activeAgent = agents[0];
let allMessages = [];
let plugins = []; // Liste des plugins chargés
let mcpTools = [];
const MCP_PRESETS = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    keywords: ['filesystem', 'files', 'dossier', 'directory', 'local'],
    description: 'Gestion complète des fichiers locaux : lire, écrire, créer, déplacer, supprimer, rechercher.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '~']
  },
  {
    id: 'git',
    name: 'Git',
    keywords: ['git', 'repo', 'repository', 'github', 'version'],
    description: 'Lecture des dépôts Git, branches et diffs.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-git', '.']
  },
  {
    id: 'postgres',
    name: 'Postgres',
    keywords: ['postgres', 'sql', 'database', 'db'],
    description: 'Interrogation d’une base PostgreSQL.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:pass@localhost:5432/db']
  },
  {
    id: 'github',
    name: 'GitHub',
    keywords: ['github', 'repo', 'issue', 'pr', 'pull request'],
    description: 'Gestion des dépôts, issues et pull requests.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github']
  },
  {
    id: 'slack',
    name: 'Slack',
    keywords: ['slack', 'chat', 'workspace', 'message'],
    description: 'Recherche et actions dans Slack.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack']
  }
];
let appConfig = { 
  openai_api_key: null, 
  anthropic_api_key: null, 
  gemini_api_key: null,
  openrouter_api_key: null,
  mcp_servers: [],
  ollama_url: 'http://localhost:11434',
  lmstudio_url: 'http://localhost:1234',
  default_provider: 'ollama',
  preferred_models: {
    ollama: 'llama3',
    lmstudio: 'local-model',
    openai: 'gpt-4o',
    gemini: 'gemini-1.5-flash',
    openrouter: 'meta-llama/llama-3-8b-instruct',
    anthropic: 'claude-3-5-sonnet-latest'
  },
  font_family: "'Inter', sans-serif",
  font_size: "15px"
};
let ollamaAvailable = false;
let isThinking = false;
let currentRequestId = null;
let currentMessageEl = null;
let attachedFile = null; // { name: string, content: string }
let attachedImages = []; // Array of base64 strings
let indexedFiles = []; // Array of { name, path, content }
let selectedFolderPath = null;
let favoriteAgents = []; // Array of agent IDs
let currentUsedSources = []; // Pour l'affichage des sources RAG
let selectedMcpServerIds = []; // Array of selected MCP server IDs
let currentConversationId = null; // ID de la conversation active (null = brouillon non sauvegardé)
let conversations = []; // Liste des métadonnées de conversations


const chatContainer = document.getElementById('chat-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const topLoadingBar = document.getElementById('top-loading-bar');
const agentList = document.getElementById('agent-list');
const activeAgentName = document.getElementById('active-agent-name');
const activeAgentDesc = document.getElementById('active-agent-desc');
const ollamaStatus = document.getElementById('ollama-status');
const settingsPanel = document.getElementById('settings-panel');

// Configuration de Marked pour utiliser Highlight.js
marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true
});

async function loadPlugins() {
  try {
    plugins = await invoke('list_plugins');
    console.log("Plugins chargés:", plugins);
  } catch (err) {
    console.error("Erreur chargement plugins:", err);
  }
}

async function loadMcpTools() {
  try {
    mcpTools = await invoke('list_mcp_tools');
    console.log("Outils MCP chargés:", mcpTools);
  } catch (err) {
    console.error("Erreur chargement MCP:", err);
    mcpTools = [];
  }
}

function normalizeMcpServers() {
  if (!Array.isArray(appConfig.mcp_servers)) appConfig.mcp_servers = [];
  appConfig.mcp_servers = appConfig.mcp_servers.map((server, idx) => ({
    id: server.id || `mcp-${idx + 1}`,
    name: server.name || `MCP ${idx + 1}`,
    transport: server.transport || 'stdio',
    command: server.command || 'npx',
    args: Array.isArray(server.args) ? server.args : [],
    env: server.env && typeof server.env === 'object' ? server.env : {},
    enabled: server.enabled !== false,
    permissions: {
      tools: server.permissions?.tools !== false,
      resources: server.permissions?.resources !== false,
      prompts: server.permissions?.prompts !== false
    }
  }));
}

function renderMcpSummary() {
  const el = document.getElementById('mcp-server-summary');
  if (!el) return;
  const count = Array.isArray(appConfig.mcp_servers) ? appConfig.mcp_servers.length : 0;
  const enabled = (appConfig.mcp_servers || []).filter(s => s.enabled !== false).length;
  el.innerText = `${count} serveur(s) configuré(s), ${enabled} activé(s).`;
  renderMcpStatusBar();
}

// ─── Barre de statut sidebar + dropdown MCP ─────────────────────────

function renderMcpStatusBar() {
  const countEl = document.getElementById('mcp-count');
  if (!countEl) return;
  const servers = appConfig.mcp_servers || [];
  const enabled = servers.filter(s => s.enabled !== false).length;
  countEl.textContent = `${enabled}/${servers.length} MCP`;

  const listEl = document.getElementById('mcp-status-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!servers.length) {
    listEl.innerHTML = '<div class="mcp-status-empty">Aucun serveur MCP configuré.<br>Ajoutez-en via les Paramètres.</div>';
    return;
  }
  servers.forEach(s => {
    const li = document.createElement('li');
    const on = s.enabled !== false;
    li.innerHTML = `
      <span class="mcp-status-dot ${on ? 'enabled' : 'disabled'}"></span>
      <span class="mcp-status-name">${s.name}</span>
      <span class="mcp-status-state">${on ? 'Actif' : 'Inactif'}</span>
    `;
    listEl.appendChild(li);
  });
}

function updateSidebarStatus() {
  const iconEl = document.querySelector('#status-active-agent .status-icon');
  const labelEl = document.querySelector('#status-active-agent .status-label');
  if (iconEl && labelEl && activeAgent) {
    iconEl.textContent = activeAgent.icon || '';
    labelEl.textContent = activeAgent.name || '';
  }
}

function setupSidebarExtras() {
  // Dropdown statut MCP
  const toggleBtn = document.getElementById('mcp-status-toggle');
  const dropdown = document.getElementById('mcp-status-dropdown');
  const closeBtn = document.getElementById('mcp-status-close');
  if (toggleBtn && dropdown) {
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
      toggleBtn.classList.toggle('open');
    };
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
        toggleBtn.classList.remove('open');
      }
    });
  }
  if (closeBtn && dropdown) {
    closeBtn.onclick = () => dropdown.classList.remove('open');
  }

  // Boutons déplier/replier toutes les catégories
  const expandAll = document.getElementById('expand-all-categories');
  const collapseAll = document.getElementById('collapse-all-categories');
  if (expandAll) expandAll.onclick = () => window.expandAllCategories();
  if (collapseAll) collapseAll.onclick = () => window.collapseAllCategories();
}

// ─── Mode d'affichage des noms (always / hover / reduced) ────────────

function applyTooltipMode() {
  const mode = appConfig.tooltip_mode || 'hover';
  document.body.classList.remove('tooltip-always', 'tooltip-hover', 'tooltip-reduced');
  document.body.classList.add(`tooltip-${mode}`);
}

function setMcpStatus(message, kind = 'loading') {
  const banner = document.getElementById('mcp-status-banner');
  if (!banner) return;
  banner.style.display = 'block';
  banner.className = `mcp-status-banner ${kind}`;
  banner.innerHTML = `<span class="mcp-status-text">${message}</span>`;
}

function clearMcpStatus() {
  const banner = document.getElementById('mcp-status-banner');
  if (!banner) return;
  banner.style.display = 'none';
  banner.innerHTML = '';
}

function resetMcpCustomForm() {
  const fields = ['mcp-custom-id', 'mcp-custom-name', 'mcp-custom-transport', 'mcp-custom-command', 'mcp-custom-args', 'mcp-custom-env'];
  const [id, name, transport, command, args, env] = fields.map(fid => document.getElementById(fid));
  if (id) id.value = '';
  if (name) name.value = '';
  if (transport) transport.value = 'stdio';
  if (command) command.value = 'npx';
  if (args) args.value = '';
  if (env) env.value = '';
  const saveBtn = document.getElementById('mcp-custom-save');
  if (saveBtn) saveBtn.innerText = 'Ajouter';
}

function fillMcpCustomForm(server) {
  document.getElementById('mcp-custom-id').value = server.id;
  document.getElementById('mcp-custom-name').value = server.name || '';
  document.getElementById('mcp-custom-transport').value = server.transport || 'stdio';
  document.getElementById('mcp-custom-command').value = server.command || 'npx';
  document.getElementById('mcp-custom-args').value = JSON.stringify(server.args || []);
  document.getElementById('mcp-custom-env').value = JSON.stringify(server.env || {}, null, 2);
  document.getElementById('mcp-perm-tools').checked = server.permissions?.tools !== false;
  document.getElementById('mcp-perm-resources').checked = server.permissions?.resources !== false;
  document.getElementById('mcp-perm-prompts').checked = server.permissions?.prompts !== false;
  document.getElementById('mcp-custom-save').innerText = 'Mettre à jour';
}

function renderMcpManager() {
  const presetList = document.getElementById('mcp-preset-list');
  const configuredList = document.getElementById('mcp-configured-list');
  const query = (document.getElementById('mcp-search')?.value || '').toLowerCase().trim();
  if (!presetList || !configuredList) return;

  const filteredPresets = MCP_PRESETS.filter(p =>
    !query || [p.name, p.description, ...(p.keywords || [])].some(v => v.toLowerCase().includes(query))
  );

  presetList.innerHTML = filteredPresets.map(p => `
    <div class="mcp-item">
      <h4>${p.name}</h4>
      <p>${p.description}</p>
      <button class="save-btn" data-mcp-preset="${p.id}" style="padding:8px 10px;">Ajouter</button>
    </div>
  `).join('') || '<div style="color: var(--text-muted); font-size: 0.8rem;">Aucun preset trouvé.</div>';

  configuredList.innerHTML = (appConfig.mcp_servers || []).map(server => `
    <div class="mcp-item">
      <h4>${server.name}</h4>
      <p><strong>${server.transport || 'stdio'}</strong> · ${server.command} ${Array.isArray(server.args) ? server.args.join(' ') : ''}</p>
      <div class="mcp-permissions">
        <label><input type="checkbox" data-mcp-permission="tools" data-mcp-id="${server.id}" ${server.permissions?.tools !== false ? 'checked' : ''} /> Tools</label>
        <label><input type="checkbox" data-mcp-permission="resources" data-mcp-id="${server.id}" ${server.permissions?.resources !== false ? 'checked' : ''} /> Resources</label>
        <label><input type="checkbox" data-mcp-permission="prompts" data-mcp-id="${server.id}" ${server.permissions?.prompts !== false ? 'checked' : ''} /> Prompts</label>
      </div>
      <label style="display:flex; align-items:center; gap:8px; font-size:0.78rem; color: var(--text-muted);">
        <input type="checkbox" data-mcp-enabled="${server.id}" ${server.enabled !== false ? 'checked' : ''} />
        Activé
      </label>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="save-btn" data-mcp-edit="${server.id}" style="padding:8px 10px;">Modifier</button>
        <button class="save-btn" data-mcp-test="${server.id}" style="padding:8px 10px;">Tester</button>
        <button class="save-btn" data-mcp-remove="${server.id}" style="padding:8px 10px; background: rgba(239,68,68,0.2);">Supprimer</button>
      </div>
    </div>
  `).join('') || '<div style="color: var(--text-muted); font-size: 0.8rem;">Aucun serveur configuré.</div>';
}

function presetToServer(preset) {
  return {
    id: `${preset.id}-${Date.now()}`.replace(/[^a-z0-9_-]/gi, '-').toLowerCase(),
    name: preset.name,
    transport: 'stdio',
    command: preset.command,
    args: preset.args || [],
    env: {},
    enabled: true,
    permissions: { tools: true, resources: true, prompts: true }
  };
}

async function persistMcpServers() {
  normalizeMcpServers();
  setMcpStatus('Sauvegarde MCP en cours...', 'loading');
  await invoke('save_config', { config: appConfig }).catch(() => {});
  await invoke('save_mcp_servers', { servers: appConfig.mcp_servers || [] }).catch(() => {});
  setTimeout(() => {
    loadMcpTools();
  }, 0);
  setMcpStatus('Serveurs MCP enregistrés.', 'ok');
  setTimeout(clearMcpStatus, 2000);
}

function upsertCustomMcpServer() {
  const id = document.getElementById('mcp-custom-id').value.trim();
  const name = document.getElementById('mcp-custom-name').value.trim();
  const transport = document.getElementById('mcp-custom-transport').value;
  const command = document.getElementById('mcp-custom-command').value.trim();
  const argsRaw = document.getElementById('mcp-custom-args').value.trim() || '[]';
  const envRaw = document.getElementById('mcp-custom-env').value.trim() || '{}';
  const permissions = {
    tools: document.getElementById('mcp-perm-tools')?.checked !== false,
    resources: document.getElementById('mcp-perm-resources')?.checked !== false,
    prompts: document.getElementById('mcp-perm-prompts')?.checked !== false
  };

  if (!name || !command) {
    alert('Nom et commande sont obligatoires.');
    return;
  }

  let args;
  let env;
  try {
    args = JSON.parse(argsRaw);
    if (!Array.isArray(args)) throw new Error('args');
  } catch {
    alert('Le champ Args doit être un JSON valide de tableau.');
    return;
  }
  try {
    env = JSON.parse(envRaw);
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('env');
  } catch {
    alert('Le champ Env doit être un JSON valide d’objet.');
    return;
  }

  normalizeMcpServers();
  const server = {
    id: id || `${name}-${Date.now()}`.replace(/[^a-z0-9_-]/gi, '-').toLowerCase(),
    name,
    transport,
    command,
    args,
    env,
    enabled: true,
    permissions
  };

  const index = appConfig.mcp_servers.findIndex(s => s.id === server.id);
  if (index >= 0) appConfig.mcp_servers[index] = server;
  else appConfig.mcp_servers.push(server);

  renderMcpManager();
  renderMcpSummary();
  persistMcpServers();
  resetMcpCustomForm();
}

// Fonction pour exécuter un outil détecté dans le texte
async function handleToolCalls(text) {
  // Format attendu : [[tool:plugin_id/tool_name?{"arg":"val"}]]
  // Permet les espaces/sauts de ligne dans le JSON
  const toolRegex = /\[\[tool:([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\?([\s\S]*?)\]\]/g;
  let match;
  let newText = text;
  let hasCalls = false;

  while ((match = toolRegex.exec(text)) !== null) {
    hasCalls = true;
    const [fullMatch, pluginId, toolName, argsStr] = match;
    try {
      const args = JSON.parse(argsStr);
      console.log(`Exécution de l'outil: ${pluginId}/${toolName}`, args);
      
      const result = pluginId.startsWith('mcp__')
        ? await invoke('run_mcp_tool', { server_id: pluginId.replace('mcp__', ''), tool_name: toolName, args })
        : await invoke('run_plugin_tool', { plugin_id: pluginId, tool_name: toolName, args });
      const resultStr = JSON.stringify(result);
      
      // Remplacer l'appel par le résultat dans le prompt suivant ou l'afficher
      newText = newText.replace(fullMatch, `\n\n[RÉSULTAT DE L'OUTIL] : ${resultStr}\n\n`);
    } catch (err) {
      newText = newText.replace(fullMatch, `\n\n[ERREUR DE L'OUTIL] : ${err}\n\n`);
    }
  }
  
  return { hasCalls, newText };
}

async function init() {
  renderAgents();
  setupEventListeners();
  setupSidebarExtras();

  // Charger d'abord la configuration légère, puis laisser le temps au rendu de s'afficher.
  const loadedConfig = await invoke('load_config').catch(() => ({}));
  appConfig = {
    ...appConfig,
    ...loadedConfig,
    preferred_models: { ...appConfig.preferred_models, ...(loadedConfig.preferred_models || {}) }
  };
  normalizeMcpServers();
  favoriteAgents = appConfig.favorites || [];

  updateSystemStatus();
  applyTypography();
  applyTooltipMode();
  renderMcpStatusBar();
  updateSidebarStatus();
  if (appConfig.font_family) document.getElementById('settings-font-family').value = appConfig.font_family;
  if (appConfig.font_size) document.getElementById('settings-font-size').value = appConfig.font_size;
  const tooltipModeSelect = document.getElementById('settings-tooltip-mode');
  if (tooltipModeSelect) tooltipModeSelect.value = appConfig.tooltip_mode || 'hover';
  selectAgent(agents[0].id, false);
  await startListeners();

  // Lancer le reste après le premier paint.
  requestAnimationFrame(() => {
    setTimeout(async () => {
      const loadedHistory = await invoke('load_history').catch(() => []);
      console.log("Historique chargé:", loadedHistory.length, "messages");
      allMessages = loadedHistory;
      renderChatHistoryIncremental();

      // Charger la liste des conversations
      await refreshConversationList();

      ollamaAvailable = await invoke('check_ollama').catch(() => false);
      updateSystemStatus();

      Promise.allSettled([loadPlugins(), loadMcpTools()]).then(() => {
        renderMcpSummary();
      });
    }, 0);
  });
}

let currentReActDepth = 0; // Profondeur actuelle de la boucle ReAct
const MAX_REACT_DEPTH = 5; // Sécurité anti-boucle infinie

async function handleReActLoop(rawText, msgEl) {
  const { hasCalls, newText } = await handleToolCalls(rawText);
  
  if (hasCalls) {
    // Sécurité : arrêter si trop d'itérations
    if (currentReActDepth >= MAX_REACT_DEPTH) {
      console.warn(`Limite ReAct atteinte (${MAX_REACT_DEPTH} itérations).`);
      msgEl.dataset.raw = newText + `\n\n> ⚠️ Nombre maximum d'actions consécutives atteint (${MAX_REACT_DEPTH}). Répondez à nouveau pour continuer.`;
      msgEl.innerHTML = marked.parse(msgEl.dataset.raw);
      currentReActDepth = 0;
      return;
    }
    currentReActDepth++;
    
    // Masquer les appels bruts et montrer les résultats
    msgEl.dataset.raw = newText;
    msgEl.innerHTML = marked.parse(newText);
    
    // Mettre à jour le message IA avec le contenu incluant les résultats d'outils
    const lastMsg = allMessages[allMessages.length - 1];
    if (lastMsg && lastMsg.role === 'ai') {
        lastMsg.content = newText;
        saveHistory();
    }
    
    // Déclencher une nouvelle réponse automatique basée sur les résultats des outils
    setTimeout(() => {
      sendMessage(true); // true pour dire "poursuite automatique"
    }, 500);
  } else {
    currentReActDepth = 0; // Reset quand l'agent a terminé
    // Si des sources ont été utilisées, on les ajoute au dernier message
    const lastMsg = allMessages[allMessages.length - 1];
    if (lastMsg && lastMsg.role === 'ai' && currentUsedSources.length > 0) {
        lastMsg.sources = [...currentUsedSources];
        renderSourcesBadge(msgEl.parentElement, currentUsedSources);
        saveHistory();
    }
    currentUsedSources = [];
  }
}

function getToolsPrompt() {
  const agentModeCheckbox = document.getElementById('agent-mode-checkbox');
  const isAgentMode = agentModeCheckbox ? agentModeCheckbox.checked : true;
  
  if (!isAgentMode) {
    return "\n[MODE CHAT SEULEMENT]\nTu es en mode conversationnel strict. Tu NE DOIS PAS utiliser d'outils, exécuter des commandes ou chercher à agir comme un agent exécutif. Réponds simplement à l'utilisateur de manière naturelle et textuelle. Les outils sont DÉSACTIVÉS.\n";
  }

  let p = "";
  let hasTools = false;

  if (plugins && plugins.length > 0) {
    p += "\n\n[SYSTÈME D'OUTILS DISPONIBLES]\n";
    p += "Tu es un AGENT actif. Tu peux utiliser des outils en insérant ce tag dans ta réponse. Remplace la partie JSON par les arguments réels :\n";
    plugins.forEach(plugin => {
      if (plugin.tools) {
        plugin.tools.forEach(tool => {
          p += `- [[tool:${plugin.id}/${tool.name}?{"param":"valeur"}]] : ${tool.description} (Schéma attendu: ${JSON.stringify(tool.parameters.properties)})\n`;
          hasTools = true;
        });
      }
    });
  }

  // Filter MCP tools by selected servers
  let mcpToolsToExpose = mcpTools || [];
  if (selectedMcpServerIds.length > 0) {
    mcpToolsToExpose = mcpToolsToExpose.filter(tool =>
      selectedMcpServerIds.includes(tool.server_id)
    );
  }

  const fsServer = findFilesystemServer();
  const fsSelected = fsServer && selectedMcpServerIds.includes(fsServer.id);

  if (mcpToolsToExpose.length > 0) {
    p += "\n[OUTILS MCP DISPONIBLES]\n";
    p += "IMPORTANT : Tu es un AGENT EXÉCUTIF, pas un simple chatbot. Tu DOIS utiliser ces outils pour répondre aux demandes en insérant le tag avec tes arguments JSON.\n";
    p += "Format EXACT attendu: [[tool:mcp__serveur/outil?{\"argument\":\"valeur\"}]]\n";
    mcpToolsToExpose.forEach(tool => {
      p += `- [[tool:mcp__${tool.server_id}/${tool.name}?{...}]] : ${tool.description || ''} (Schéma JSON des arguments: ${JSON.stringify(tool.input_schema?.properties || {})})\n`;
      hasTools = true;
    });
  }

  if (fsSelected) {
    p += `\n[RÈGLE ABSOLUE FILESYSTEM]
Le serveur MCP Filesystem est ACTIF avec des capacités COMPLÈTES :
- list_directory : explorer un dossier
- read_file : lire un fichier
- write_file : créer/écraser un fichier
- create_directory : créer un dossier
- delete_entry : supprimer (demander confirmation à l'utilisateur avant !)
- move_entry : déplacer/renommer
- search_files : chercher par nom

Tu as accès complet aux fichiers locaux. INTERDICTION de répondre "Je ne peux pas accéder aux fichiers".
Pour une demande comme "range mes fichiers" ou "crée un rapport", enchaîne plusieurs outils sans redemander.
Pour les actions destructrices (delete_entry), confirme d'abord avec l'utilisateur.
Utilise [[tool:mcp__${fsServer.id}/<outil>?{...}]] pour agir.\n`;
    hasTools = true;
  }

  if (hasTools) {
    p += "\nRègle d'exécution : Dès que tu as besoin d'une info, insère UNIQUEMENT le tag [[tool:...]] avec un JSON valide et ARRÊTE-TOI. Le système l'exécutera et te donnera le résultat pour continuer.\n";
  }

  return p;
}

function findFilesystemServer() {
  return (appConfig.mcp_servers || []).find(server => {
    const name = (server.name || '').toLowerCase();
    const id = (server.id || '').toLowerCase();
    const args = Array.isArray(server.args) ? server.args.join(' ').toLowerCase() : '';
    return (name.includes('filesystem') || id.includes('filesystem') || args.includes('@modelcontextprotocol/server-filesystem')) && server.enabled !== false;
  });
}

function getActiveMcpServers() {
  return (appConfig.mcp_servers || []).filter(server => server.enabled !== false);
}

function findMcpServerByNameOrId(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return null;
  return getActiveMcpServers().find(server => {
    const name = (server.name || '').toLowerCase();
    const id = (server.id || '').toLowerCase();
    return name === q || id === q || name.includes(q) || id.includes(q);
  }) || null;
}

function updateCommandBadge() {
  const badge = document.getElementById('active-command-badge');
  if (!badge) return;

  const val = chatInput.value;
  if (val.startsWith('/') && val.includes(' ')) {
    const cmd = val.split(' ')[0].toLowerCase();
    const agentCmd = activeAgent.commands?.find(c => c.cmd === cmd);
    
    if (agentCmd) {
      badge.innerHTML = `<span>✨ Action active :</span> ${agentCmd.desc}`;
      badge.style.display = 'flex';
      return;
    } else if (activeAgent.id === 'translator' && cmd.length === 3) {
      badge.innerHTML = `<span>🌍 Traduction :</span> ${cmd.substring(1).toUpperCase()}`;
      badge.style.display = 'flex';
      return;
    }
  }

  // If no magic command is active, show selected MCPs
  if (selectedMcpServerIds.length > 0) {
    const names = selectedMcpServerIds
      .map(id => (appConfig.mcp_servers || []).find(s => s.id === id)?.name || id)
      .filter(Boolean);
    if (names.length > 0) {
      badge.innerHTML = `<span>🔌 MCP :</span> ${names.join(', ')} <span style="cursor:pointer;opacity:0.5;" onclick="window.clearAllMcpServers()">✕</span>`;
      badge.style.display = 'flex';
      return;
    }
  }

  badge.style.display = 'none';
}

window.clearAllMcpServers = function() {
  selectedMcpServerIds = [];
  updateCommandBadge();
};

function handleMcpSuggestions() {
  const suggestionsEl = document.getElementById('mcp-suggestions');
  if (!suggestionsEl) return;

  const val = chatInput.value;
  const match = val.match(/\/mcp\s*([^\s]*)$/i);
  
  if (match) {
    const query = match[1].toLowerCase();
    const activeServers = getActiveMcpServers();
    const filtered = activeServers.filter(s => 
      !query || s.name.toLowerCase().includes(query) || s.id.toLowerCase().includes(query)
    );

    // Always offer "clear all" option at bottom if some are selected
    const clearItem = selectedMcpServerIds.length > 0 ?
      [{ id: '__clear__', name: '✕ Désactiver tous les MCP', command: '', enabled: true }] : [];

    const allItems = [...filtered, ...clearItem];

    if (allItems.length > 0) {
      suggestionsEl.innerHTML = allItems.map((s, index) => {
        const isActive = selectedMcpServerIds.includes(s.id);
        const checkIcon = s.id === '__clear__' ? '' : (isActive ? '✅ ' : '⬜ ');
        return `
          <div class="mcp-suggestion-item ${isActive ? 'active' : ''}" data-index="${index}" data-id="${s.id}" data-name="${s.name}">
            <span>${checkIcon}${s.name}</span>
            <span class="mcp-desc">${s.id === '__clear__' ? 'Désélectionne tous les serveurs' : (s.command || s.id)}</span>
          </div>
        `;
      }).join('');
      suggestionsEl.style.display = 'flex';

      // Click handler — toggle selection, keep dropdown open for multi-select
      suggestionsEl.querySelectorAll('.mcp-suggestion-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // prevent blur
          const id = item.dataset.id;
          
          if (id === '__clear__') {
            selectedMcpServerIds = [];
            chatInput.value = val.replace(/\/mcp\s*[^\s]*$/i, '').trim();
            suggestionsEl.style.display = 'none';
          } else {
            const idx = selectedMcpServerIds.indexOf(id);
            if (idx >= 0) {
              selectedMcpServerIds.splice(idx, 1);
            } else {
              selectedMcpServerIds.push(id);
            }
            // Re-render to show updated checkboxes
            handleMcpSuggestions();
          }
          
          chatInput.focus();
          updateCommandBadge();
        });
      });
      return;
    }
  }

  suggestionsEl.style.display = 'none';
}

function setSelectedMcpServer(server) {
  if (!server) {
    selectedMcpServerIds = [];
  } else if (!selectedMcpServerIds.includes(server.id)) {
    selectedMcpServerIds.push(server.id);
  }
  updateCommandBadge();
}

function wantsLocalFilesystem(text) {
  const t = (text || '').toLowerCase();
  return [
    'dossier', 'folder', 'fichier', 'files', 'filesystem', 'bureau',
    'downloads', 'téléchargements', 'telechargements', 'workspace',
    'documents', 'projet', 'project', 'répertoire', 'repertoire', 'dir'
  ].some(k => t.includes(k));
}

function mcpServerWantsLocalFiles(server, text) {
  const combined = `${server.name || ''} ${server.id || ''}`.toLowerCase();
  return combined.includes('filesystem') || wantsLocalFilesystem(text);
}

async function buildFilesystemContext(text, force = false) {
  const server = findFilesystemServer();
  if (!server || (!force && !wantsLocalFilesystem(text))) return '';

  let targetPath = selectedFolderPath || '';
  if (!targetPath) {
    targetPath = await invoke('get_desktop_dir').catch(() => '');
  }
  if (!targetPath) targetPath = '.';
  try {
    const listing = await invoke('run_mcp_tool', {
      server_id: server.id,
      tool_name: 'list_directory',
      args: { path: targetPath === '.' ? '' : '' }
    });
    const entries = listing?.entries || listing?.result?.entries || [];
    const preview = entries.slice(0, 20).map(entry => {
      const type = entry.type || 'file';
      const size = entry.size != null ? ` (${entry.size} bytes)` : '';
      return `- ${entry.name}${type === 'directory' ? '/' : ''}${size}`;
    }).join('\n');

    let block = `\n\n[CONTEXT MCP FILESYSTEM]\nRacine utilisée: ${targetPath}\nContenu du dossier:\n${preview || '(vide)'}\n`;

    const fileMatch = text.match(/(?:fichier|file)\s+([^\s,.;]+)/i);
    if (fileMatch && fileMatch[1]) {
      const filePath = fileMatch[1];
      const fileContent = await invoke('run_mcp_tool', {
        server_id: server.id,
        tool_name: 'read_file',
        args: { path: filePath }
      }).catch(() => null);
      const content = fileContent?.content || fileContent?.result?.content;
      if (content) {
        block += `\nContenu de ${filePath}:\n${content.substring(0, 6000)}\n`;
      }
    }
    return block + '\n';
  } catch (err) {
    console.warn('Filesystem MCP auto-context failed:', err);
    return `\n\n[CONTEXT MCP FILESYSTEM]\nErreur de lecture automatique: ${err}\n`;
  }
}

async function buildSelectedMcpContext(text) {
  if (selectedMcpServerIds.length === 0) return '';
  let combined = '';

  for (const sid of selectedMcpServerIds) {
    const server = (appConfig.mcp_servers || []).find(s => s.id === sid && s.enabled !== false);
    if (!server) continue;

    if (mcpServerWantsLocalFiles(server, text)) {
      combined += await buildFilesystemContext(text, true);
    } else {
      combined += `\n\n[CONTEXT MCP: ${server.name}]\nServeur actif: ${server.name} (${server.id}).\nL'utilisateur a sélectionné ce serveur avec /mcp. Utilise ses outils pour répondre.\n`;
    }
  }
  return combined;
}

async function startListeners() {
  // Écouter les chunks de réponse (même canal pour Ollama et Cloud)
  await listen('ollama-chunk', (event) => {
    const { request_id, chunk, done } = event.payload;
    
    // Ignorer si ce n'est pas la requête actuelle
    if (request_id !== currentRequestId) return;
    if (!currentMessageEl) return;
    
    if (currentMessageEl.classList.contains('typing-indicator')) {
      currentMessageEl.classList.remove('typing-indicator');
      currentMessageEl.classList.add('message', 'ai', 'markdown-body');
      currentMessageEl.innerText = '';
      currentMessageEl.dataset.raw = '';
    }

    // Filtrage de la réflexion (<think>...</think>)
    let filteredChunk = chunk;
    if (chunk.includes('<think>')) {
      isThinking = true;
      filteredChunk = chunk.split('<think>')[0];
    }
    
    let contentToAppend = isThinking ? '' : filteredChunk;
    
    if (chunk.includes('</think>')) {
      isThinking = false;
      contentToAppend = chunk.split('</think>')[1] || '';
    }

    if (contentToAppend) {
      // Progression visuelle lors de la réception des chunks (US-07)
      if (topLoadingBar && topLoadingBar.classList.contains('active')) {
        topLoadingBar.style.width = '70%';
      }

      currentMessageEl.dataset.raw += contentToAppend;
      currentMessageEl.innerHTML = marked.parse(currentMessageEl.dataset.raw);
      
      // Highlight code blocks
      currentMessageEl.querySelectorAll('pre code').forEach((block) => {
        if (!block.dataset.highlighted) {
          hljs.highlightElement(block);
          block.dataset.highlighted = 'true';
        }
      });
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    
    if (done) {
      // Terminer l'indicateur de chargement (US-07)
      if (topLoadingBar) {
        topLoadingBar.style.width = '100%';
        setTimeout(() => {
          topLoadingBar.classList.remove('active');
          topLoadingBar.style.width = '0%';
        }, 500);
      }

      document.getElementById('stop-btn').style.display = 'none';
      document.getElementById('send-btn').style.display = 'flex';
      
      const rawText = currentMessageEl.dataset.raw;
      const msgEl = currentMessageEl;
      const wrapper = msgEl.closest('.message-wrapper');
      
      if (wrapper) {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'message-actions';
        
        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = '✕';
        deleteBtn.title = 'Supprimer';
        deleteBtn.onclick = () => deleteMessage('ai', rawText);
        
        const copyBtn = document.createElement('button');
        copyBtn.innerHTML = '📋';
        copyBtn.title = 'Copier';
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(rawText);
          copyBtn.innerText = '✅';
          setTimeout(() => copyBtn.innerText = '📋', 2000);
        };

        const exportMsgBtn = document.createElement('button');
        exportMsgBtn.innerHTML = '📥';
        exportMsgBtn.title = 'Exporter cette réponse';
        exportMsgBtn.onclick = () => {
          const blob = new Blob([rawText], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `response_${Date.now()}.txt`;
          a.click();
          URL.revokeObjectURL(url);
        };

        actionsEl.appendChild(copyBtn);
        actionsEl.appendChild(exportMsgBtn);
        actionsEl.appendChild(deleteBtn);
        wrapper.appendChild(actionsEl);
      }
      
      // On sauvegarde ici avant de vider currentMessageEl pour US-01
      allMessages.push({ 
        role: 'ai', 
        content: rawText, 
        agent_id: activeAgent.id, 
        sources: [...currentUsedSources] 
      });
      saveHistory();
      tryAutoTitle();

      currentMessageEl = null; 
      currentRequestId = null;
      
      handleReActLoop(rawText, msgEl);
    }
  });
}

function updateSystemStatus() {
  const provider = appConfig.default_provider;
  const statusEl = document.getElementById('ollama-status');
  
  if (provider === 'ollama') {
    if (ollamaAvailable) {
      statusEl.innerHTML = '● Ollama (Local)';
      statusEl.style.color = '#4ade80';
    } else {
      statusEl.innerHTML = '● Local Offline';
      statusEl.style.color = '#f87171';
    }
  } else if (provider === 'lmstudio') {
    // LM Studio est local, pas besoin de clé
    statusEl.innerHTML = '● LM Studio (Local)';
    statusEl.style.color = '#4ade80'; // Vert comme Ollama
  } else {
    const key = getApiKeyForProvider(provider);
    if (key && key.length > 10) {
      statusEl.innerHTML = `● ${provider.toUpperCase()} Ready`;
      statusEl.style.color = '#60a5fa';
    } else {
      statusEl.innerHTML = `● ${provider.toUpperCase()} Missing Key`;
      statusEl.style.color = '#fbbf24';
    }
  }
}

// ─── Rendu des agents par catégories dépliables ──────────────────────

let collapsedCategories = JSON.parse(localStorage.getItem('collapsedCategories') || '[]');

function renderAgents() {
  const container = document.getElementById('agent-categories');
  if (!container) { renderAgentsLegacy(); return; }
  container.innerHTML = '';

  // Grouper par catégorie, favoris d'abord dans une catégorie "Favoris"
  const favs = agents.filter(a => favoriteAgents.includes(a.id));
  const groups = new Map();
  if (favs.length) groups.set('Favoris', favs);
  agents.forEach(a => {
    const cat = a.category || 'Général';
    if (!groups.has(cat)) groups.set(cat, []);
    if (!favoriteAgents.includes(a.id)) groups.get(cat).push(a);
  });

  groups.forEach((list, cat) => {
    const section = document.createElement('div');
    section.className = `agent-category ${collapsedCategories.includes(cat) ? 'collapsed' : ''}`;
    section.dataset.category = cat;

    // Indiquer si l'agent actif se trouve dans une catégorie repliée
    const hasActive = list.some(a => a.id === activeAgent.id);
    if (hasActive && collapsedCategories.includes(cat)) section.classList.add('contains-active');

    const header = document.createElement('button');
    header.className = `category-header ${collapsedCategories.includes(cat) ? '' : 'open'}`;
    header.innerHTML = `
      <span class="category-name">${cat === 'Favoris' ? '★ ' : ''}${cat}</span>
      <span class="category-count">${list.length}</span>
      <span class="category-chevron">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </span>
    `;
    if (hasActive) {
      const dot = document.createElement('span');
      dot.className = 'category-active-dot';
      dot.title = 'Agent actif ici';
      header.insertBefore(dot, header.firstChild);
    }
    header.onclick = () => toggleCategory(cat);

    const bodyWrapper = document.createElement('div');
    bodyWrapper.className = 'category-body-wrapper';

    const body = document.createElement('div');
    body.className = 'category-body';
    list.forEach((agent, i) => {
      const item = buildAgentItem(agent);
      // Apparition en cascade légère quand la catégorie est ouverte
      if (!collapsedCategories.includes(cat)) {
        item.style.animation = `slideUp var(--duration-normal) var(--ease-out) ${i * 30}ms backwards`;
      }
      body.appendChild(item);
    });

    bodyWrapper.appendChild(body);
    section.appendChild(header);
    section.appendChild(bodyWrapper);
    container.appendChild(section);
  });
}

function buildAgentItem(agent) {
  const li = document.createElement('li');
  li.className = `agent-item ${activeAgent.id === agent.id ? 'active' : ''}`;
  const isFav = favoriteAgents.includes(agent.id);
  li.innerHTML = `
    <div class="agent-icon">${agent.icon}</div>
    <div class="agent-tooltip">${agent.name}</div>
    <button class="fav-btn ${isFav ? 'active' : ''}" onclick="window.toggleFavorite(event, '${agent.id}')">
      ${isFav ? '★' : '☆'}
    </button>
  `;
  li.onclick = (e) => {
    if (e.target.closest('.fav-btn')) return;
    selectAgent(agent.id);
  };
  return li;
}

function toggleCategory(cat) {
  const idx = collapsedCategories.indexOf(cat);
  if (idx >= 0) collapsedCategories.splice(idx, 1);
  else collapsedCategories.push(cat);
  localStorage.setItem('collapsedCategories', JSON.stringify(collapsedCategories));
  renderAgents();
}

window.expandAllCategories = () => {
  collapsedCategories = [];
  localStorage.setItem('collapsedCategories', '[]');
  renderAgents();
};

window.collapseAllCategories = () => {
  collapsedCategories = [...new Set(agents.map(a => a.category || 'Général'))];
  localStorage.setItem('collapsedCategories', JSON.stringify(collapsedCategories));
  renderAgents();
};

// Fallback si le nouveau conteneur est absent
function renderAgentsLegacy() {
  agentList.innerHTML = '';
  const sortedAgents = [...agents].sort((a, b) => {
    const aFav = favoriteAgents.includes(a.id);
    const bFav = favoriteAgents.includes(b.id);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;
    return 0;
  });
  sortedAgents.forEach(agent => agentList.appendChild(buildAgentItem(agent)));
}

window.toggleFavorite = (e, id) => {
  e.stopPropagation();
  if (favoriteAgents.includes(id)) {
    favoriteAgents = favoriteAgents.filter(fid => fid !== id);
  } else {
    favoriteAgents.push(id);
  }
  appConfig.favorites = favoriteAgents;
  invoke('save_config', { config: appConfig });
  renderAgents();
};

function applyTypography() {
  if (!appConfig.font_family) return;
  document.documentElement.style.setProperty('--app-font', appConfig.font_family);
  document.documentElement.style.setProperty('--app-font-size', appConfig.font_size || '15px');
}

// ─── Model Picker (dropdown custom avec recherche + filtres) ──────────

// Stockage : modèle choisi manuellement par agent (sinon fallback sur agent.model)
let agentModelOverrides = {}; // { agentId: modelName }

// Cache des modèles OpenRouter avec métadonnées
let openrouterModelsCache = null; // [{ id, name, isFree }]

async function fetchOpenrouterModels() {
  if (openrouterModelsCache) return openrouterModelsCache;
  try {
    const raw = await invoke('list_openrouter_models_detailed');
    openrouterModelsCache = raw;
  } catch {
    openrouterModelsCache = [];
  }
  return openrouterModelsCache;
}

// État du picker
const modelPickerState = {
  models: [],       // liste plate d'IDs disponibles pour le provider actuel
  details: {},      // id -> { name, isFree } (openrouter uniquement)
  filter: 'all',
  search: '',
  highlighted: -1,
};

function modelPickerFiltered() {
  const q = modelPickerState.search.toLowerCase();
  return modelPickerState.models.filter(id => {
    const det = modelPickerState.details[id];
    if (modelPickerState.filter === 'free' && !(det?.isFree)) return false;
    if (modelPickerState.filter === 'paid' && (det?.isFree)) return false;
    if (q && !id.toLowerCase().includes(q) && !(det?.name || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderModelPickerList() {
  const listEl = document.getElementById('model-picker-list');
  if (!listEl) return;
  const filtered = modelPickerFiltered();

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="model-picker-empty">Aucun modèle trouvé</div>';
    return;
  }

  const current = agentModelOverrides[activeAgent.id] || '';
  const maxShown = 300; // évite de rendre 419 nodes d'un coup

  listEl.innerHTML = filtered.slice(0, maxShown).map((id, i) => {
    const det = modelPickerState.details[id];
    const freeBadge = det?.isFree ? '<span class="badge-free">Gratuit</span>' : '';
    const sub = det?.name && det.name !== id ? `<div class="model-name">${det.name}</div>` : '';
    return `
      <div class="model-option ${id === current ? 'selected' : ''} ${i === modelPickerState.highlighted ? 'highlighted' : ''}" data-model="${id}" role="option" aria-selected="${id === current}">
        <div style="min-width:0; flex-grow:1;">
          <div class="model-id">${id}</div>
          ${sub}
        </div>
        <div class="model-meta">${freeBadge}</div>
      </div>`;
  }).join('') + (filtered.length > maxShown ? `<div class="model-picker-empty">+ ${filtered.length - maxShown} autres… affinez la recherche</div>` : '');

  // Clic sur une option
  listEl.querySelectorAll('.model-option').forEach(opt => {
    opt.addEventListener('click', () => {
      selectModel(opt.dataset.model);
    });
  });
}

function selectModel(modelId) {
  closeModelPicker();
  const label = document.getElementById('model-picker-label');
  const badge = document.getElementById('active-agent-model');

  if (!modelId) {
    delete agentModelOverrides[activeAgent.id];
    if (label) label.textContent = `Par défaut (${activeAgent.model})`;
    if (badge) badge.innerText = activeAgent.model;
  } else {
    agentModelOverrides[activeAgent.id] = modelId;
    if (label) label.textContent = modelId;
    if (badge) badge.innerText = modelId;
  }
}

function openModelPicker() {
  const dropdown = document.getElementById('model-picker-dropdown');
  const btn = document.getElementById('model-picker-btn');
  if (!dropdown || !btn) return;
  dropdown.style.display = 'flex';
  document.getElementById('model-picker').classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  modelPickerState.highlighted = -1;
  renderModelPickerList();
  setTimeout(() => document.getElementById('model-picker-search')?.focus(), 30);
}

function closeModelPicker() {
  const dropdown = document.getElementById('model-picker-dropdown');
  const btn = document.getElementById('model-picker-btn');
  if (!dropdown) return;
  dropdown.style.display = 'none';
  document.getElementById('model-picker')?.classList.remove('open');
  btn?.setAttribute('aria-expanded', 'false');
}

async function populateAgentModelSelect() {
  const label = document.getElementById('model-picker-label');
  if (!label) return;

  const provider = getProvider();
  let options = [];
  modelPickerState.details = {};
  modelPickerState.filter = 'all';
  modelPickerState.search = '';

  const searchInput = document.getElementById('model-picker-search');
  if (searchInput) searchInput.value = '';
  document.querySelectorAll('.model-filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));

  try {
    if (provider === 'ollama') {
      options = await invoke('list_ollama_models').catch(() => []);
    } else if (provider === 'lmstudio') {
      options = await invoke('list_lmstudio_models').catch(() => []);
    } else if (provider === 'openrouter') {
      const detailed = await fetchOpenrouterModels();
      options = detailed.map(m => m.id);
      detailed.forEach(m => { modelPickerState.details[m.id] = m; });
    }
  } catch { /* providers indisponibles */ }

  // Fallback statique si rien de disponible
  if (options.length === 0) {
    if (provider === 'openai') options = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];
    else if (provider === 'gemini') options = ['gemini-1.5-flash', 'gemini-1.5-pro'];
    else if (provider === 'anthropic') options = ['claude-3-5-sonnet-latest', 'claude-3-opus-latest'];
  }

  modelPickerState.models = options;

  const override = agentModelOverrides[activeAgent.id];
  if (override) {
    label.textContent = override;
  } else {
    label.textContent = `Par défaut (${activeAgent.model})`;
  }

  // Masquer les filtres gratuit/payant si pas de métadonnées (providers locaux)
  const filtersRow = document.querySelector('.model-picker-filters');
  if (filtersRow) {
    filtersRow.style.display = Object.keys(modelPickerState.details).length > 0 ? 'flex' : 'none';
  }
}

function listScrollToHighlighted() {
  const el = document.querySelector('.model-option.highlighted');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function getModelForCurrentRequest() {
  return agentModelOverrides[activeAgent.id] || activeAgent.model;
}

window.selectAgent = async (id, shouldWelcome = true) => {
  // Arrêter toute génération en cours lors du changement d'agent
  if (currentMessageEl) {
    await invoke('stop_generation');
    currentRequestId = null;
    currentMessageEl = null;
  }

  activeAgent = agents.find(a => a.id === id);
  renderAgents();
  activeAgentName.innerText = activeAgent.name;
  activeAgentDesc.innerText = activeAgent.desc;
  updateSidebarStatus();
  const modelEl = document.getElementById('active-agent-model');
  if (modelEl) modelEl.innerText = activeAgent.model;

  // Remplir le sélecteur de modèle du header pour cet agent
  await populateAgentModelSelect();
  
  // Mise à jour du placeholder pour rappeler les commandes
  chatInput.placeholder = `Parler à ${activeAgent.name} (tapez /help pour les commandes)`;

  // Changer d'agent = quitter la conversation courante (1 conversation = 1 agent)
  const convMeta = conversations.find(c => c.id === currentConversationId);
  if (!convMeta || convMeta.agent_id !== id) {
    currentConversationId = null;
    autoTitleDone = false;
  }
  renderConversationList();
  
  renderChatHistory();
  if (shouldWelcome && !allMessages.some(m => m.agent_id === activeAgent.id)) {
    // Message de bienvenue non persisté : ne crée pas de conversation vide
    addMessage('ai', `Bonjour ! Je suis ${activeAgent.name}.`, null, false);
    // Le retirer de allMessages juste après l'affichage (addMessage avec shouldSave=false ne l'ajoute pas,
    // mais on veut aussi qu'il disparaisse au prochain renderChatHistory)
  }
};

function renderChatHistory() {
  chatContainer.innerHTML = '';
  const msgs = allMessages.filter(m => m.agent_id === activeAgent.id);
  if (msgs.length === 0) {
    const suggestions = (activeAgent.commands || [])
      .slice(0, 4)
      .map(c => `<button class="suggestion-chip" data-cmd="${c.cmd}">${c.cmd} — ${c.desc}</button>`)
      .join('');
    chatContainer.innerHTML = `
      <div class="empty-state">
        <div class="icon">${activeAgent.icon}</div>
        <h3>${activeAgent.name}</h3>
        <p>${activeAgent.desc}</p>
        ${suggestions ? `<div class="empty-suggestions">${suggestions}</div>` : ''}
      </div>
    `;
    chatContainer.querySelectorAll('.suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chatInput.value = chip.dataset.cmd + ' ';
        chatInput.focus();
      });
    });
    return;
  }
  msgs.forEach(m => {
    const el = addMessage(m.role, m.content, m.images, false, m.cmd_used);
    if (m.sources && m.sources.length > 0) {
      renderSourcesBadge(el.closest('.message-wrapper'), m.sources);
    }
  });
}

function renderChatHistoryIncremental() {
  chatContainer.innerHTML = '';
  const msgs = allMessages.filter(m => m.agent_id === activeAgent.id);
  if (msgs.length === 0) {
    renderChatHistory();
    return;
  }

  const chunkSize = 20;
  let index = 0;
  const renderChunk = () => {
    const slice = msgs.slice(index, index + chunkSize);
    slice.forEach(m => {
      const el = addMessage(m.role, m.content, m.images, false, m.cmd_used);
      if (m.sources && m.sources.length > 0) {
        renderSourcesBadge(el.closest('.message-wrapper'), m.sources);
      }
    });
    index += chunkSize;
    if (index < msgs.length) {
      setTimeout(renderChunk, 0);
    }
  };
  renderChunk();
}

function renderSourcesBadge(wrapper, sources) {
  const sourcesContainer = document.createElement('div');
  sourcesContainer.className = 'sources-container';
  sourcesContainer.innerHTML = `<span class="sources-label">📚 Sources :</span>`;
  
  sources.forEach(source => {
    const badge = document.createElement('span');
    badge.className = 'source-item-badge';
    badge.innerText = source;
    sourcesContainer.appendChild(badge);
  });
  
  wrapper.appendChild(sourcesContainer);
}

// ─── Aperçu d'app web générée (HTML/CSS/JS) ──────────────────────────────

// Détecte si le texte contient une app web complète et attache une carte d'aperçu au message
function attachPreviewCardIfWebApp(msgEl, text) {
  // Cherche un bloc de code HTML avec <!DOCTYPE ou <html (complet)
  const htmlBlockMatch = text.match(/```html\s*([\s\S]*?)```/i);
  if (!htmlBlockMatch) return;
  const htmlContent = htmlBlockMatch[1];
  const isFullPage = /<!DOCTYPE|<html/i.test(htmlContent);
  const hasBody = /<body/i.test(htmlContent);
  if (!isFullPage && !hasBody) return;

  const wrapper = msgEl.closest('.message-wrapper');
  if (!wrapper || wrapper.querySelector('.webapp-preview-card')) return;

  const card = document.createElement('div');
  card.className = 'webapp-preview-card';
  card.innerHTML = `
    <div class="webapp-preview-info">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
        <line x1="8" y1="21" x2="16" y2="21"></line>
        <line x1="12" y1="17" x2="12" y2="21"></line>
      </svg>
      <span>Application web détectée — prévisualisez-la en un clic</span>
    </div>
    <button class="webapp-open-btn">▶ Aperçu live</button>
  `;
  card.querySelector('.webapp-open-btn').addEventListener('click', () => {
    openWebAppPreview(htmlContent);
  });
  wrapper.appendChild(card);
}

// Ouvre une fenêtre flottante avec l'app rendue dans un iframe sandboxé
function openWebAppPreview(htmlContent) {
  // Ferme l'aperçu existant s'il y en a un
  closeWebAppPreview();

  const overlay = document.createElement('div');
  overlay.id = 'webapp-preview-overlay';
  overlay.className = 'webapp-preview-overlay';
  overlay.innerHTML = `
    <div class="webapp-preview-window">
      <div class="webapp-preview-header">
        <span class="webapp-preview-title">Aperçu de l'application</span>
        <div class="webapp-preview-actions">
          <button id="webapp-reload" title="Recharger">⟳</button>
          <button id="webapp-external" title="Ouvrir dans le navigateur">↗</button>
          <button id="webapp-close" title="Fermer">✕</button>
        </div>
      </div>
      <iframe id="webapp-frame" sandbox="allow-scripts allow-forms allow-modals"></iframe>
    </div>
  `;
  document.body.appendChild(overlay);

  const frame = overlay.querySelector('#webapp-frame');
  frame.srcdoc = htmlContent;

  overlay.querySelector('#webapp-close').onclick = closeWebAppPreview;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeWebAppPreview();
  });
  overlay.querySelector('#webapp-reload').onclick = () => { frame.srcdoc = htmlContent; };
  overlay.querySelector('#webapp-external').onclick = () => {
    // Sauvegarde temporaire puis ouverture dans le navigateur par défaut via Tauri opener
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') {
      closeWebAppPreview();
      document.removeEventListener('keydown', escClose);
    }
  });
}

function closeWebAppPreview() {
  const existing = document.getElementById('webapp-preview-overlay');
  if (existing) existing.remove();
}
window.closeWebAppPreview = closeWebAppPreview;

function addMessage(role, text, images = null, shouldSave = true, cmd_used = null) {
  // Enlever l'état vide si présent
  const emptyState = chatContainer.querySelector('.empty-state');
  if (emptyState) chatContainer.removeChild(emptyState);

  const msgWrapper = document.createElement('div');
  msgWrapper.className = `message-wrapper ${role}`;

  const msgEl = document.createElement('div');
  msgEl.className = `message ${role}`;
  
  // Badge de commande magique
  if (cmd_used) {
    const cmdBadge = document.createElement('span');
    cmdBadge.className = 'msg-cmd-badge';
    cmdBadge.innerText = `via ${cmd_used}`;
    msgEl.appendChild(cmdBadge);
  }
  if (images && images.length > 0) {
    const imagesContainer = document.createElement('div');
    imagesContainer.className = 'message-images';
    images.forEach(img => {
      const imgEl = document.createElement('img');
      imgEl.src = `data:image/jpeg;base64,${img}`;
      imagesContainer.appendChild(imgEl);
    });
    msgEl.appendChild(imagesContainer);
  }

  const contentEl = document.createElement('div');
  contentEl.className = 'message-content';

  if (role === 'ai') {
    msgEl.classList.add('markdown-body');
    contentEl.innerHTML = marked.parse(text);
    // Coloration syntaxique
    contentEl.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block);
    });
    // Détection d'une app web complète (HTML) → carte d'aperçu
    attachPreviewCardIfWebApp(msgEl, text);
  } else {
    contentEl.innerText = text;
  }

  msgEl.appendChild(contentEl);
  
  // Actions du message (Supprimer, Exporter)
  const actionsEl = document.createElement('div');
  actionsEl.className = 'message-actions';
  
  const deleteBtn = document.createElement('button');
  deleteBtn.innerHTML = '✕';
  deleteBtn.title = 'Supprimer';
  deleteBtn.onclick = () => deleteMessage(role, text);
  
  const copyBtn = document.createElement('button');
  copyBtn.innerHTML = '📋';
  copyBtn.title = 'Copier';
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(text);
    copyBtn.innerText = '✅';
    setTimeout(() => copyBtn.innerText = '📋', 2000);
  };

  const exportMsgBtn = document.createElement('button');
  exportMsgBtn.innerHTML = '📥';
  exportMsgBtn.title = 'Exporter cette réponse';
  exportMsgBtn.onclick = () => {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `response_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  actionsEl.appendChild(copyBtn);
  actionsEl.appendChild(exportMsgBtn);
  actionsEl.appendChild(deleteBtn);
  msgWrapper.appendChild(msgEl);
  msgWrapper.appendChild(actionsEl);

  chatContainer.appendChild(msgWrapper);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  if (shouldSave) {
    allMessages.push({ 
      role, 
      content: text, 
      agent_id: activeAgent.id, 
      images: images, 
      cmd_used: cmd_used 
    });
    saveHistory();
  }
  return contentEl; 
}

function addGeneratedImageMessage(imageUrl, prompt, localPath = null) {
  const msgWrapper = document.createElement('div');
  msgWrapper.className = 'message-wrapper ai';
  
  const msgEl = document.createElement('div');
  msgEl.className = 'message ai generated-image-card';
  
  msgEl.innerHTML = `
    <div class="generated-image-container">
      <img src="${imageUrl}" class="main-generated-img" />
      <div class="image-overlay-actions">
        <button onclick="window.downloadGeneratedImage('${imageUrl}')">🌐 URL</button>
        ${localPath ? `<button onclick="window.openPath('${localPath}')">📂 Local</button>` : ''}
      </div>
    </div>
    <div class="image-prompt-footer">
      <strong>Prompt:</strong> ${prompt}
      ${localPath ? `<div class="local-path-hint">Sauvegardé : ${localPath.split('/').pop()}</div>` : ''}
    </div>
  `;
  
  msgWrapper.appendChild(msgEl);
  chatContainer.appendChild(msgWrapper);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  
  allMessages.push({ 
    role: 'ai', 
    content: `[Image générée]: ${imageUrl}`, 
    agent_id: 'artist', 
    type: 'image',
    localPath: localPath 
  });
  saveHistory();
}

window.openPath = async (path) => {
    try {
        await invoke('plugin:opener|open', { path });
    } catch (e) {
        console.error("Erreur ouverture dossier:", e);
    }
};

function showContextualHelp() {
  const helpPanel = document.getElementById('help-panel');
  const dynamicSection = document.getElementById('dynamic-commands-help');
  
  let html = `<h4>✨ Commandes pour ${activeAgent.name}</h4><ul class="feature-list">`;
  
  if (activeAgent.commands && activeAgent.commands.length > 0) {
    activeAgent.commands.forEach(c => {
      html += `<li><code>${c.cmd}</code> : ${c.desc}</li>`;
    });
  } else {
    html += `<li>Aucune commande spécifique pour cet agent.</li>`;
  }
  
  html += `<li><code>/clear</code> : Effacer l'historique</li>`;
  html += `<li><code>/help</code> : Voir cette aide</li>`;
  html += `</ul>`;

  // Section MCP dynamique dans l'aide de l'agent
  const activeServers = getActiveMcpServers();
  html += `<h4 style="margin-top: 15px; display: flex; align-items: center; gap: 5px;">🔌 Serveurs MCP Actifs</h4>`;
  if (activeServers.length > 0) {
    html += `<ul class="feature-list">`;
    activeServers.forEach(s => {
      const isSelected = selectedMcpServerIds.includes(s.id);
      const statusText = isSelected ? ' <span style="color: var(--accent-neon); font-size: 0.75rem;">🟢 actif</span>' : '';
      html += `<li><code>/mcp ${s.name}</code> : Utiliser ${s.name}${statusText}</li>`;
    });
    html += `<li><code>/mcp clear</code> : Désactiver les serveurs MCP</li>`;
    html += `</ul>`;
  } else {
    html += `<p style="font-size: 0.75rem; opacity: 0.6; margin-left: 10px; font-style: italic;">Aucun serveur MCP actif. Activez-en dans les paramètres ⚙️.</p>`;
  }
  
  dynamicSection.innerHTML = html;
  helpPanel.classList.add('open');
}

window.downloadGeneratedImage = async (url) => {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.download = `art_${Date.now()}.png`;
  a.click();
};

async function generateArtistImage(prompt) {
  // Détection du format
  let size = "1024x1024";
  if (prompt.toLowerCase().includes("1792x1024") || prompt.toLowerCase().includes("paysage") || prompt.toLowerCase().includes("horizontal") || prompt.toLowerCase().includes("/wide")) {
    size = "1792x1024";
  } else if (prompt.toLowerCase().includes("1024x1792") || prompt.toLowerCase().includes("portrait") || prompt.toLowerCase().includes("vertical") || prompt.toLowerCase().includes("/tall")) {
    size = "1024x1792";
  }

  const loadingEl = document.createElement('div');
  loadingEl.className = 'message ai typing-indicator';
  loadingEl.innerHTML = `🎨 L'artiste prépare sa toile (${size})... <span></span><span></span><span></span>`;
  chatContainer.appendChild(loadingEl);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  try {
    const provider = appConfig.default_provider || 'openai';
    let apiKey = appConfig.openai_api_key;
    if (provider === 'gemini') apiKey = appConfig.gemini_api_key;
    else if (provider === 'openrouter') apiKey = appConfig.openrouter_api_key;

    const imageUrl = await invoke('generate_image', {
      provider,
      api_key: apiKey,
      prompt: prompt,
      size: size
    });
    
    // Sauvegarder automatiquement en local
    const localPath = await invoke('save_image_to_gallery', { url: imageUrl }).catch(e => {
        console.error("Échec sauvegarde locale:", e);
        return null;
    });

    chatContainer.removeChild(loadingEl);
    addGeneratedImageMessage(imageUrl, prompt, localPath);
  } catch (err) {
    if (chatContainer.contains(loadingEl)) chatContainer.removeChild(loadingEl);
    addMessage('ai', `Désolé, l'artiste a rencontré un problème : ${err}`);
  }
}

function deleteMessage(role, content) {
  allMessages = allMessages.filter(m => !(m.role === role && m.content === content));
  saveHistory();
  renderChatHistory();
}

async function saveHistory() {
  try {
    // Sauvegarde dans la conversation active (création automatique si brouillon)
    if (!currentConversationId) {
      currentConversationId = `conv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    }
    const agentMessages = allMessages.filter(m => m.agent_id === activeAgent.id);
    const meta = await invoke('save_conversation', {
      conversationId: currentConversationId,
      title: conversationTitle(agentMessages),
      agentId: activeAgent.id,
      messages: agentMessages
    });
    await refreshConversationList();
  } catch (e) { console.error('Erreur sauvegarde conversation:', e); }
}

// Génère un titre : première question utilisateur tronquée, sinon titre par défaut
function conversationTitle(messages) {
  const firstUserMsg = messages.find(m => m.role === 'user');
  if (firstUserMsg) {
    const t = firstUserMsg.content.trim().replace(/\s+/g, ' ');
    return t.length > 40 ? t.substring(0, 40) + '…' : t;
  }
  return null;
}

// Auto-title IA : appelé une fois après la première réponse complète.// Remplace le titre tronqué par un titre intelligent si Ollama est dispo.
let autoTitleDone = false;
async function tryAutoTitle() {
  if (autoTitleDone || !currentConversationId || !ollamaAvailable) return;
  const agentMessages = allMessages.filter(m => m.agent_id === activeAgent.id);
  const firstUser = agentMessages.find(m => m.role === 'user');
  const firstAi = agentMessages.find(m => m.role === 'ai');
  if (!firstUser || !firstAi) return;

  autoTitleDone = true;
  try {
    const title = await invoke('generate_conversation_title', {
      firstMessage: firstUser.content
    });
    if (title && currentConversationId) {
      await invoke('rename_conversation', { conversationId: currentConversationId, title });
      await refreshConversationList();
    }
  } catch (e) {
    // Silencieux : on garde le titre tronqué par défaut
    console.debug('Auto-title ignoré:', e);
  }
}

async function refreshConversationList() {
  try {
    conversations = await invoke('list_conversations');
    renderConversationList();
  } catch (e) { console.error('Erreur liste conversations:', e); }
}

// Recherche : filtre par titre ET par contenu des messages
let conversationSearchCache = {}; // id -> messages (rempli à la demande)

function filterConversations(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return conversations;
  return conversations.filter(conv => {
    if ((conv.title || '').toLowerCase().includes(q)) return true;
    return false; // le contenu est filtré de façon asynchrone ci-dessous
  });
}

async function searchInConversationContents(q, candidates) {
  // Charge les contenus manquants puis filtre
  const results = [];
  for (const conv of candidates) {
    try {
      const [, msgs] = await invoke('load_conversation', { conversationId: conv.id });
      const match = msgs.some(m => (m.content || '').toLowerCase().includes(q));
      if (match) results.push(conv);
    } catch { /* conversation illisible, on l'ignore */ }
  }
  return results;
}

function renderConversationList(listOverride = null) {
  const listEl = document.getElementById('conversation-list');
  if (!listEl) return;
  const items = listOverride || conversations;
  listEl.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'conversations-empty';
    empty.textContent = listOverride ? 'Aucun résultat' : 'Aucune conversation';
    listEl.appendChild(empty);
    return;
  }

  items.forEach(conv => {
    const li = document.createElement('li');
    li.className = `conversation-item ${conv.id === currentConversationId ? 'active' : ''}`;
    li.title = conv.title || 'Sans titre';

    const agent = agents.find(a => a.id === conv.agent_id);
    const icon = agent ? agent.icon : '💬';
    const title = conv.title || 'Sans titre';

    li.innerHTML = `
      <span class="conv-icon">${icon}</span>
      <span class="conv-title">${title}</span>
      <button class="conv-delete-btn" title="Supprimer" aria-label="Supprimer la conversation">✕</button>
    `;

    li.onclick = (e) => {
      if (e.target.closest('.conv-delete-btn')) return;
      selectConversation(conv.id);
    };

    li.querySelector('.conv-delete-btn').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Supprimer « ${title} » ?`)) return;
      try {
        await invoke('delete_conversation', { conversationId: conv.id });
        if (currentConversationId === conv.id) {
          currentConversationId = null;
          allMessages = allMessages.filter(m => m.agent_id !== conv.agent_id);
          selectAgent(activeAgent.id, false);
        }
        await refreshConversationList();
      } catch (err) { console.error('Erreur suppression:', err); }
    };

    listEl.appendChild(li);
  });
}

window.selectConversation = async (conversationId) => {
  try {
    const [meta, msgs] = await invoke('load_conversation', { conversationId });
    currentConversationId = conversationId;

    // Basculer vers l'agent de la conversation si différent
    if (meta.agent_id !== activeAgent.id) {
      await window.selectAgent(meta.agent_id, false);
    }

    // Remplacer les messages de cet agent par ceux de la conversation
    allMessages = allMessages.filter(m => m.agent_id !== meta.agent_id).concat(msgs);
    renderChatHistoryIncremental();
    renderConversationList();
  } catch (err) {
    console.error('Erreur chargement conversation:', err);
  }
};

window.startNewConversation = () => {
  currentConversationId = null;
  // Retirer les messages de l'agent actif de la mémoire (ils restent dans leur fichier)
  allMessages = allMessages.filter(m => m.agent_id !== activeAgent.id);
  renderChatHistory();
  renderConversationList();
  chatInput.focus();
};

function getProvider() {
  if (!ollamaAvailable && appConfig.default_provider === 'ollama') {
    // Fallback vers OpenAI si disponible
    if (appConfig.openai_api_key) return 'openai';
    if (appConfig.gemini_api_key) return 'gemini';
    if (appConfig.openrouter_api_key) return 'openrouter';
    return 'none';
  }
  return appConfig.default_provider;
}

function getApiKeyForProvider(provider) {
  switch(provider) {
    case 'openai': return appConfig.openai_api_key;
    case 'gemini': return appConfig.gemini_api_key;
    case 'openrouter': return appConfig.openrouter_api_key;
    case 'anthropic': return appConfig.anthropic_api_key;
    default: return null;
  }
}

async function sendMessage(isAutoResponse = false) {
  let text = isAutoResponse ? "[CONTINUATION AVEC RÉSULTAT]" : chatInput.value.trim();
  if (!text) return;

  let displayContent = null;
  let cmd_used = null;

  // --- Parser MCP anywhere in the input ---
  if (!isAutoResponse) {
    const mcpMatch = text.match(/\/mcp\s+([^\s]+)/i);
    if (mcpMatch) {
      const serverParam = mcpMatch[1];
      // remove /mcp <server> from text
      text = text.replace(mcpMatch[0], '').trim();
      
      if (serverParam.toLowerCase() === 'clear' || serverParam.toLowerCase() === 'none') {
        setSelectedMcpServer(null);
        if (!text) {
          addMessage('ai', 'MCP désactivé pour la conversation actuelle.');
          chatInput.value = '';
          return;
        }
      } else {
        const server = findMcpServerByNameOrId(serverParam);
        if (server) {
          setSelectedMcpServer(server);
          if (!text) {
            addMessage('ai', `Serveur MCP sélectionné : ${server.name}`);
            chatInput.value = '';
            return;
          }
        } else {
          if (!text) {
            addMessage('ai', `Serveur MCP introuvable : ${serverParam}`);
            chatInput.value = '';
            return;
          }
        }
      }
    } else if (text.trim().toLowerCase() === '/mcp') {
      const activeServers = getActiveMcpServers();
      const list = activeServers.map(s => `- ${s.name} (${s.id})`).join('\n') || '(aucun MCP actif)';
      addMessage('ai', `MCP actifs:\n${list}\n\nUtilise /mcp <nom> pour sélectionner un serveur.`);
      chatInput.value = '';
      return;
    }
  }

  // --- Système de Slash Commands ---
  if (!isAutoResponse && text.startsWith('/')) {
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();
    const content = parts.slice(1).join(' ');

    // Commandes globales
    if (cmd === '/help') {
      showContextualHelp();
      chatInput.value = '';
      return;
    }
    if (cmd === '/clear') {
      document.getElementById('clear-btn').click();
      chatInput.value = '';
      return;
    }

    // Commandes spécifiques à l'agent
    const agentCmd = activeAgent.commands?.find(c => c.cmd === cmd);

    if (agentCmd) {
      if (!content && cmd !== '/summary' && cmd !== '/ocr' && cmd !== '/analyze') {
        alert(`La commande ${cmd} nécessite un texte ou un contexte.`);
        return;
      }
      text = `${agentCmd.prompt}${content}`;
      displayContent = content || cmd;
      cmd_used = cmd;
    } else if (activeAgent.id === 'translator' && cmd.length === 3) {
      const langCode = cmd.substring(1);
      text = `Traduis précisément ce texte vers la langue correspondant au code "${langCode}" : \n---\n${content}\n---`;
      displayContent = content;
      cmd_used = cmd;
    }
  }

  // Activer l'indicateur de chargement (US-07)
  if (topLoadingBar) {
    topLoadingBar.style.width = '30%';
    topLoadingBar.classList.add('active');
  }

  // Gestion spécifique pour l'agent Artiste
  if (activeAgent.id === 'artist') {
    if (!appConfig.openai_api_key) {
      alert("La génération d'images nécessite une clé API OpenAI dans les paramètres.");
      return;
    }
    generateArtistImage(text);
    chatInput.value = '';
    updateCommandBadge();
    return;
  }

  const fullPromptToSend = text;
  const userVisibleText = displayContent || text;

  chatInput.value = '';
  updateCommandBadge();
  chatInput.style.height = 'auto';
  document.getElementById('send-btn').style.display = 'none';
  document.getElementById('stop-btn').style.display = 'flex';
  
  if (!isAutoResponse) {
    addMessage('user', userVisibleText, [...attachedImages], true, cmd_used);
  }

  // Générer un ID de requête unique
  currentRequestId = Math.random().toString(36).substring(2, 15);

  const msgWrapper = document.createElement('div');
  msgWrapper.className = 'message-wrapper ai';

  currentMessageEl = document.createElement('div');
  currentMessageEl.className = 'typing-indicator';
  currentMessageEl.innerHTML = '<span></span><span></span><span></span>';
  
  msgWrapper.appendChild(currentMessageEl);
  chatContainer.appendChild(msgWrapper);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  const provider = getProvider();

  // Capturer les fichiers et images actuels puis vider la prévisualisation immédiatement
  const imagesToSend = [...attachedImages];
  const fileToSend = attachedFile;
  
  attachedFile = null;
  attachedImages = [];
  document.getElementById('file-preview').innerHTML = '';

  try {
    // Augmentation de la fenêtre de contexte (12 messages au lieu de 6)
    const agentMessages = allMessages.filter(m => m.agent_id === activeAgent.id).slice(-12);
    
    // Formatage plus clair pour l'IA
    const context = agentMessages.map(m => {
      const role = m.role === 'user' ? 'Utilisateur' : 'Assistant';
      return `[${role}]: ${m.content}`;
    }).join('\n\n');

    let filesystemContext = '';
    let selectedMcpContext = '';
    if (selectedMcpServerIds.length > 0) {
      selectedMcpContext = await buildSelectedMcpContext(text);
      if (selectedMcpContext) {
        setMcpStatus(`MCP actifs: ${selectedMcpServerIds.length}`, 'ok');
      }
    }
    if (wantsLocalFilesystem(text) && findFilesystemServer()) {
      setMcpStatus('Lecture locale via MCP Filesystem...', 'loading');
      filesystemContext = await buildFilesystemContext(text);
      clearMcpStatus();
    }

    let fullPrompt = `INSTRUCTIONS SYSTÈME :\n${activeAgent.systemPrompt}\n${getToolsPrompt()}\n\n`;
    if (selectedMcpContext) {
      fullPrompt += `${selectedMcpContext}`;
    }
    if (filesystemContext) {
      fullPrompt += `${filesystemContext}`;
    }

    // Injection intelligente de la Base de Connaissance (RAG)
    if (indexedFiles.length > 0) {
      const keywords = text.toLowerCase().split(' ').filter(w => w.length > 3);
      const relevantFiles = indexedFiles.filter(file => {
        const contentLower = file.content.toLowerCase();
        const nameLower = file.name.toLowerCase();
        return keywords.some(k => contentLower.includes(k) || nameLower.includes(k));
      }).slice(0, 3);

      if (relevantFiles.length > 0) {
        // Garder les noms pour l'affichage
        currentUsedSources = relevantFiles.map(f => f.name);
        
        fullPrompt += "BASE DE CONNAISSANCE LOCALE (Fichiers pertinents trouvés) :\n";
        relevantFiles.forEach(file => {
          fullPrompt += `FICHIER: ${file.name}\nCONTENU:\n${file.content.substring(0, 1500)}\n---\n`;
        });
        fullPrompt += "\n";
      }
    }

    fullPrompt += `CONTEXTE DE LA CONVERSATION (Historique récent) :\n${context}\n\n`;
    
    if (fileToSend) {
      fullPrompt += `DOCUMENT JOINT POUR CETTE REQUÊTE (${fileToSend.name}) :\n---\n${fileToSend.content}\n---\n\n`;
    }

    fullPrompt += `DERNIÈRE QUESTION DE L'UTILISATEUR :\n${text}\n\nAssistant:`;

    if (provider === 'ollama') {
      try {
        // Modèle choisi manuellement > modèle de l'agent > fallback préféré
        let modelToUse = getModelForCurrentRequest();
        const localModels = await invoke('list_ollama_models').catch(() => []);
        if (!localModels.includes(modelToUse) && appConfig.preferred_models?.ollama) {
          console.warn(`Modèle agent '${modelToUse}' non trouvé. Utilisation du modèle préféré: ${appConfig.preferred_models.ollama}`);
          modelToUse = appConfig.preferred_models.ollama;
        }

        await invoke('ask_ollama_stream', { 
          requestId: currentRequestId,
          model: modelToUse, 
          prompt: `${fullPrompt}${fullPromptToSend}`,
          images: imagesToSend
        });
      } catch (err) {
      handleError(err, 'ollama', { fullPrompt, fullPromptToSend, imagesToSend });
    }
    } else if (provider === 'lmstudio') {
      try {
        // Modèle choisi manuellement > modèle de l'agent > fallback préféré (LM Studio)
        let modelToUse = getModelForCurrentRequest();
        const localModels = await invoke('list_lmstudio_models').catch(() => []);
        if (!localModels.includes(modelToUse) && appConfig.preferred_models?.lmstudio) {
          console.warn(`Modèle agent '${modelToUse}' non trouvé sur LM Studio. Utilisation du modèle préféré: ${appConfig.preferred_models.lmstudio}`);
          modelToUse = appConfig.preferred_models.lmstudio;
        }

        await invoke('ask_lmstudio_stream', { 
          requestId: currentRequestId,
          model: modelToUse, 
          prompt: `${fullPrompt}${fullPromptToSend}`
        });
      } catch (err) {
      handleError(err, 'lmstudio', { fullPrompt, fullPromptToSend });
    }
    } else if (provider !== 'none') {
      try {
        await callCloudStream(provider, activeAgent.systemPrompt, fullPromptToSend, imagesToSend);
      } catch (err) {
        handleError(err, provider, { fullPrompt, fullPromptToSend, imagesToSend });
      }
    } else {
      currentMessageEl.className = 'message ai';
      currentMessageEl.innerText = '⚠️ Aucun service IA disponible. Vérifiez Ollama ou ajoutez une clé API dans les paramètres.';
      currentRequestId = null;
      currentMessageEl = null;
      document.getElementById('stop-btn').style.display = 'none';
      document.getElementById('send-btn').style.display = 'flex';
    }
  } catch (err) {
    handleError(err, 'system');
  }
}

function handleError(err, provider, context = null) {
  console.error(`Erreur [${provider}]:`, err);
  
  if (topLoadingBar) {
    topLoadingBar.classList.remove('active');
    topLoadingBar.style.width = '0%';
  }

  if (currentMessageEl) {
    currentMessageEl.className = 'message ai error-message';
    
    let errorTitle = "Erreur de communication";
    let errorMsg = err;
    let suggestions = "";

    if (err.includes("Connexion Ollama échouée")) {
      errorTitle = "Ollama est hors ligne";
      errorMsg = `L'application ne parvient pas à contacter Ollama sur ${appConfig.ollama_url}.`;
      if (appConfig.openai_api_key || appConfig.gemini_api_key) {
        suggestions = `<button class="error-action-btn" onclick="window.retryWithCloud()">Réessayer avec le Cloud ☁️</button>`;
      }
    } else if (err.includes("Connexion LM Studio échouée")) {
      errorTitle = "LM Studio est hors ligne";
      errorMsg = `L'application ne parvient pas à contacter LM Studio sur ${appConfig.lmstudio_url}.`;
      suggestions = `<button class="error-action-btn" onclick="document.getElementById('settings-btn').click()">Vérifier l'URL ⚙️</button>`;
    } else if (err.includes("401") || err.includes("clé API")) {
      errorTitle = "Clé API Invalide";
      errorMsg = `La clé pour ${provider} semble incorrecte ou expirée.`;
      suggestions = `<button class="error-action-btn" onclick="document.getElementById('settings-btn').click()">Ouvrir les Paramètres ⚙️</button>`;
    } else if (err.includes("429") || err.includes("quota")) {
      errorTitle = "Limite de quota atteinte";
      errorMsg = `Vous avez dépassé votre quota chez ${provider}.`;
      if (ollamaAvailable) {
        suggestions = `<button class="error-action-btn" onclick="window.retryWithOllama()">Basculer sur Ollama (Local) 🏠</button>`;
      }
    } else if (err.includes("404")) {
      errorTitle = "Modèle introuvable";
      errorMsg = `Le modèle sélectionné n'est pas disponible chez ${provider}.`;
    }

    currentMessageEl.innerHTML = `
      <div class="error-container">
        <strong>⚠️ ${errorTitle}</strong>
        <p>${errorMsg}</p>
        <div class="error-actions">
          <button class="error-action-btn primary" onclick="window.retryLastMessage()">Réessayer 🔄</button>
          ${suggestions}
        </div>
        <small>Détail technique : ${err}</small>
      </div>
    `;
  }

  currentRequestId = null;
  currentMessageEl = null;
  document.getElementById('stop-btn').style.display = 'none';
  document.getElementById('send-btn').style.display = 'flex';
}

window.retryLastMessage = () => {
  const lastUserMsg = allMessages.filter(m => m.role === 'user').pop();
  if (lastUserMsg) {
    // Supprimer le message d'erreur et le dernier message IA si vide
    const errorEls = chatContainer.querySelectorAll('.error-message');
    errorEls.forEach(el => el.remove());
    
    chatInput.value = lastUserMsg.content;
    sendMessage();
  }
};

window.retryWithCloud = async () => {
  appConfig.default_provider = appConfig.openai_api_key ? 'openai' : 'gemini';
  updateSystemStatus();
  window.retryLastMessage();
};

window.retryWithOllama = async () => {
  appConfig.default_provider = 'ollama';
  updateSystemStatus();
  window.retryLastMessage();
};

async function callCloudStream(provider, systemPrompt, userMessage, images) {
  const apiKey = getApiKeyForProvider(provider);
  if (!apiKey) {
    throw new Error(`Clé API manquante pour le fournisseur ${provider}.`);
  }

  const badge = document.createElement('span');
  badge.className = 'cloud-badge';
  
  let displayModel = agentModelOverrides[activeAgent.id] || appConfig.preferred_models[provider] || activeAgent.model;
  
  if (provider === 'openai') { badge.innerText = '☁ OpenAI (Fallback)'; }
  else if (provider === 'gemini') { badge.innerText = '✨ Gemini (Fallback)'; }
  else if (provider === 'openrouter') { badge.innerText = '🌐 OpenRouter'; }
  else if (provider === 'anthropic') { badge.innerText = '🦉 Anthropic'; }
  
  chatContainer.appendChild(badge);

  return await invoke('ask_cloud_stream', {
    requestId: currentRequestId,
    provider: provider,
    apiKey: apiKey,
    model: displayModel,
    systemPrompt: systemPrompt,
    userMessage: userMessage,
    images: images
  });
}

window.exportChat = async (format) => {
  document.getElementById('export-menu').classList.remove('open');
  try {
    const savedPath = await invoke('export_conversation', {
      agent_id: activeAgent.id,
      agentName: activeAgent.name,
      format,
    });
    addMessage('ai', `✅ Conversation exportée : ${savedPath}`);
  } catch (err) {
    addMessage('ai', `⚠️ Export impossible : ${err}`);
  }
};

function setupEventListeners() {
  // Voice Recognition (Web Speech API)
  const voiceBtn = document.getElementById('voice-btn');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'fr-FR';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      voiceBtn.classList.add('recording');
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      chatInput.value += transcript;
      chatInput.style.height = 'auto';
      chatInput.style.height = (chatInput.scrollHeight) + 'px';
    };

    recognition.onend = () => {
      voiceBtn.classList.remove('recording');
    };

    voiceBtn.addEventListener('click', () => {
      if (voiceBtn.classList.contains('recording')) {
        recognition.stop();
      } else {
        recognition.start();
      }
    });
  } else {
    voiceBtn.addEventListener('click', () => {
      alert("La dictée vocale n'est pas supportée par votre système ou nécessite des permissions supplémentaires.");
    });
  }

  // --- Drag & Drop Amélioré ---
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.add('dragging');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.remove('dragging');
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.remove('dragging');
    
    const files = e.dataTransfer.files;
    
    if (!files || files.length === 0) {
      // Tentative via items (certains Linux/WebViews)
      const items = e.dataTransfer.items;
      if (items && items.length > 0) {
        alert("Fichier détecté via items. Tentative de lecture...");
      } else {
        alert("Aucun fichier détecté dans l'événement drop.");
        return;
      }
    }

    for (const file of (files.length > 0 ? files : [])) {
      const name = file.name;
      const ext = name.split('.').pop().toLowerCase();
      const isImage = ['png', 'jpg', 'jpeg', 'webp'].includes(ext);

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const result = event.target.result;
          if (!result) throw new Error("Échec de lecture du fichier");

          const previewEl = document.getElementById('file-preview');
          
          if (isImage) {
            const base64 = result.split(',')[1];
            attachedImages.push(base64);
            
            const imgTag = document.createElement('div');
            imgTag.className = 'file-tag image-tag';
            imgTag.innerHTML = `
              <img src="data:image/${ext};base64,${base64}" style="height: 30px; border-radius: 4px;" />
              <span>${name}</span>
              <button onclick="window.removeImage(this, '${base64}')">✕</button>
            `;
            previewEl.appendChild(imgTag);
          } else {
            attachedFile = { name, content: result };
            previewEl.innerHTML = `
              <div class="file-tag">
                <span>📎 ${name}</span>
                <button onclick="window.removeFile()">✕</button>
              </div>
            `;
          }
        } catch (err) {
          console.error("Erreur Drop:", err);
          alert("Erreur lors de la lecture du fichier : " + name);
        }
      };

      if (isImage) {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    }
  });

  window.removeImage = (btn, base64) => {
    attachedImages = attachedImages.filter(img => img !== base64);
    btn.parentElement.remove();
  };

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl + K : Clear current agent history
    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      document.getElementById('clear-btn').click();
    }
    // Ctrl + Comma : Open Settings
    if (e.ctrlKey && e.key === ',') {
      e.preventDefault();
      document.getElementById('settings-btn').click();
    }
    // Ctrl + E : Open Export Menu
    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault();
      document.getElementById('export-btn').click();
    }

    // Alt + [1-3] : Switch Agent (Custom)
    if (e.altKey && e.key >= '1' && e.key <= '3') {
      const targetId = appConfig.custom_shortcuts?.[e.key];
      if (targetId) {
        selectAgent(targetId);
      }
    }
  });

  // File Attachment
  document.getElementById('attach-btn').addEventListener('click', async () => {
    try {
      if (!open) {
        console.error("Plugin Dialog non trouvé dans window.__TAURI__", window.__TAURI__);
        return alert("Erreur : Le plugin Dialog n'est pas initialisé ou autorisé. Vérifiez la configuration Tauri v2.");
      }
      
      const selected = await open({
        multiple: false,
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          { name: 'Texte/Code', extensions: ['txt', 'js', 'py', 'rs', 'html', 'css', 'md', 'json', 'log'] }
        ]
      });

      if (selected) {
        const ext = selected.split('.').pop().toLowerCase();
        const isImage = ['png', 'jpg', 'jpeg', 'webp'].includes(ext);
        const name = selected.split('/').pop();
        const previewEl = document.getElementById('file-preview');

        if (isImage) {
          const base64 = await invoke('read_file_base64', { path: selected });
          attachedImages.push(base64);
          
          const imgTag = document.createElement('div');
          imgTag.className = 'file-tag image-tag';
          imgTag.innerHTML = `
            <img src="data:image/${ext};base64,${base64}" style="height: 30px; border-radius: 4px;" />
            <span>${name}</span>
            <button onclick="this.parentElement.remove()">✕</button>
          `;
          previewEl.appendChild(imgTag);
        } else {
          const content = await invoke('read_file_content', { path: selected });
          attachedFile = { name, content };
          
          previewEl.innerHTML = `
            <div class="file-tag">
              <span>📎 ${name}</span>
              <button onclick="window.removeFile()">✕</button>
            </div>
          `;
        }
      }
    } catch (err) {
      console.error('Erreur attachement:', err);
    }
  });

  window.removeFile = () => {
    attachedFile = null;
    document.getElementById('file-preview').innerHTML = '';
  };

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { 
      // If suggestions dropdown is visible, check if we want to intercept, else send message.
      const suggestionsEl = document.getElementById('mcp-suggestions');
      if (suggestionsEl && suggestionsEl.style.display === 'flex') {
        // If they press Enter while suggestions are open, we can just hide it or do nothing, or we send. Let's just send.
        suggestionsEl.style.display = 'none';
      }
      e.preventDefault(); 
      sendMessage(); 
    }
    if (e.key === 'Escape') {
      const suggestionsEl = document.getElementById('mcp-suggestions');
      if (suggestionsEl) suggestionsEl.style.display = 'none';
    }
  });
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = (chatInput.scrollHeight) + 'px';
    updateCommandBadge();
    handleMcpSuggestions();
  });

  document.getElementById('clear-btn').addEventListener('click', async () => {
    allMessages = allMessages.filter(m => m.agent_id !== activeAgent.id);
    await saveHistory();
    renderChatHistory();
  });

  // Nouvelle conversation
  document.getElementById('new-conversation-btn').addEventListener('click', () => {
    window.startNewConversation();
  });

  // Model Picker (dropdown avec recherche + filtres)
  const pickerBtn = document.getElementById('model-picker-btn');
  if (pickerBtn) {
    pickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('model-picker-dropdown');
      if (dropdown.style.display === 'none' || !dropdown.style.display) {
        openModelPicker();
      } else {
        closeModelPicker();
      }
    });
  }

  const pickerSearch = document.getElementById('model-picker-search');
  if (pickerSearch) {
    pickerSearch.addEventListener('input', () => {
      modelPickerState.search = pickerSearch.value;
      modelPickerState.highlighted = -1;
      renderModelPickerList();
    });
    pickerSearch.addEventListener('keydown', (e) => {
      const filtered = modelPickerFiltered();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        modelPickerState.highlighted = Math.min(modelPickerState.highlighted + 1, filtered.length - 1);
        renderModelPickerList();
        listScrollToHighlighted();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        modelPickerState.highlighted = Math.max(modelPickerState.highlighted - 1, 0);
        renderModelPickerList();
        listScrollToHighlighted();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const idx = modelPickerState.highlighted >= 0 ? modelPickerState.highlighted : 0;
        if (filtered[idx]) selectModel(filtered[idx]);
      } else if (e.key === 'Escape') {
        closeModelPicker();
      }
    });
  }

  document.querySelectorAll('.model-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.model-filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      modelPickerState.filter = chip.dataset.filter;
      modelPickerState.highlighted = -1;
      renderModelPickerList();
    });
  });

  // Fermer le picker au clic extérieur
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#model-picker')) closeModelPicker();
  });

  // Recherche de conversations (debounce 250ms)
  let searchTimeout = null;
  const searchInput = document.getElementById('conversation-search');
  searchInput.addEventListener('input', async () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      const q = searchInput.value.trim();
      if (!q) {
        renderConversationList();
        return;
      }
      // Filtre rapide par titre
      const byTitle = filterConversations(q);
      if (byTitle.length > 0) {
        renderConversationList(byTitle);
      }
      // Puis recherche approfondie dans le contenu (async)
      const candidates = byTitle.length > 0 ? byTitle : conversations;
      const inContent = await searchInConversationContents(q.toLowerCase(), candidates);
      renderConversationList(inContent);
    }, 250);
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    document.getElementById('export-menu').classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.export-dropdown')) {
      document.getElementById('export-menu')?.classList.remove('open');
    }
    if (!e.target.closest('.input-area')) {
      const suggestionsEl = document.getElementById('mcp-suggestions');
      if (suggestionsEl) suggestionsEl.style.display = 'none';
    }
  });

  document.getElementById('settings-btn').addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    document.getElementById('settings-provider').value = appConfig.default_provider;
    document.getElementById('settings-openai-key').value = appConfig.openai_api_key || '';
    document.getElementById('settings-gemini-key').value = appConfig.gemini_api_key || '';
    document.getElementById('settings-openrouter-key').value = appConfig.openrouter_api_key || '';
    document.getElementById('settings-anthropic-key').value = appConfig.anthropic_api_key || '';
    renderMcpSummary();
    
    updateSettingsVisibility();
    updateModelSelect();
    // Remplir les selects de raccourcis
    populateShortcutSelects();
    renderMcpSummary();
  });

  const mcpManagerPanel = document.getElementById('mcp-manager-panel');
  document.getElementById('open-mcp-manager').addEventListener('click', () => {
    normalizeMcpServers();
    renderMcpManager();
    resetMcpCustomForm();
    clearMcpStatus();
    mcpManagerPanel.classList.add('open');
  });
  document.getElementById('open-mcp-import').addEventListener('click', () => {
    normalizeMcpServers();
    renderMcpManager();
    resetMcpCustomForm();
    clearMcpStatus();
    mcpManagerPanel.classList.add('open');
    document.getElementById('mcp-search').focus();
  });
  document.getElementById('mcp-manager-close').addEventListener('click', () => {
    mcpManagerPanel.classList.remove('open');
  });
  document.getElementById('mcp-manager-done').addEventListener('click', () => {
    mcpManagerPanel.classList.remove('open');
  });
  document.getElementById('mcp-search').addEventListener('input', renderMcpManager);
  document.getElementById('mcp-custom-save').addEventListener('click', upsertCustomMcpServer);
  document.getElementById('mcp-custom-reset').addEventListener('click', resetMcpCustomForm);
  document.getElementById('mcp-preset-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mcp-preset]');
    if (!btn) return;
    const preset = MCP_PRESETS.find(p => p.id === btn.dataset.mcpPreset);
    if (!preset) return;
    appConfig.mcp_servers = appConfig.mcp_servers || [];
    appConfig.mcp_servers.push(presetToServer(preset));
    renderMcpManager();
    renderMcpSummary();
    persistMcpServers();
  });
  document.getElementById('mcp-configured-list').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-mcp-remove]');
    const editBtn = e.target.closest('[data-mcp-edit]');
    const testBtn = e.target.closest('[data-mcp-test]');
    const enabledToggle = e.target.closest('[data-mcp-enabled]');
    const permToggle = e.target.closest('[data-mcp-permission]');
    if (removeBtn) {
      const id = removeBtn.dataset.mcpRemove;
      appConfig.mcp_servers = (appConfig.mcp_servers || []).filter(s => s.id !== id);
      renderMcpManager();
      renderMcpSummary();
      persistMcpServers();
    } else if (editBtn) {
      const id = editBtn.dataset.mcpEdit;
      const server = (appConfig.mcp_servers || []).find(s => s.id === id);
      if (!server) return;
      fillMcpCustomForm(server);
    } else if (testBtn) {
      const id = testBtn.dataset.mcpTest;
      testBtn.disabled = true;
      testBtn.innerText = '...';
      const server = (appConfig.mcp_servers || []).find(s => s.id === id);
      const details = server ? `${server.command} ${(server.args || []).join(' ')}` : id;
      setMcpStatus(`Test en cours pour ${server?.name || id} : ${details}`, 'loading');
  if (server?.command) {
    console.log('MCP test command:', server.command, server.args || []);
  }
      invoke('test_mcp_server', { serverId: id })
        .then((result) => {
          setMcpStatus(`OK: ${result.server_name} - ${result.tools_count} outil(s) détecté(s)${result.mode ? ` (${result.mode})` : ''}.`, 'ok');
        })
        .catch((err) => {
          setMcpStatus(`Test échoué: ${err}`, 'error');
        })
        .finally(() => {
          testBtn.disabled = false;
          testBtn.innerText = 'Tester';
          setTimeout(clearMcpStatus, 4000);
        });
    } else if (enabledToggle) {
      const id = enabledToggle.dataset.mcpEnabled;
      const server = (appConfig.mcp_servers || []).find(s => s.id === id);
      if (server) server.enabled = enabledToggle.checked;
      persistMcpServers();
    } else if (permToggle) {
      const id = permToggle.dataset.mcpId;
      const server = (appConfig.mcp_servers || []).find(s => s.id === id);
      if (!server) return;
      if (!server.permissions) server.permissions = { tools: true, resources: true, prompts: true };
      server.permissions[permToggle.dataset.mcpPermission] = permToggle.checked;
      persistMcpServers();
    }
  });

  // --- Galerie ---
  document.getElementById('gallery-btn').addEventListener('click', async () => {
    document.getElementById('gallery-overlay').classList.add('open');
    await loadGallery();
  });

  async function loadGallery() {
    const grid = document.getElementById('gallery-grid');
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">✨ Préparation de la galerie...</div>';
    
    try {
      const images = await invoke('list_gallery_images');
      if (images.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">🎨 Votre collection est vide. Générez une œuvre pour commencer !</div>';
        return;
      }
      
      grid.innerHTML = images.map(path => {
        const assetUrl = window.__TAURI__.tauri.convertFileSrc(path);
        const fileName = path.split('/').pop();
        return `
          <div class="gallery-card" onclick="window.openLightbox('${assetUrl}', '${path.replace(/\\/g, '\\\\')}')">
            <img src="${assetUrl}" loading="lazy" />
            <div class="gallery-card-overlay">
              <div style="font-size: 0.7rem; color: white; opacity: 0.8; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${fileName}</div>
              <div class="gallery-actions">
                <button class="gallery-action-btn" title="Ouvrir" onclick="event.stopPropagation(); window.openLightbox('${assetUrl}', '${path.replace(/\\/g, '\\\\')}')">👁️</button>
                <button class="gallery-action-btn" title="Dossier" onclick="event.stopPropagation(); window.openPath('${path.replace(/\\/g, '\\\\')}')">📂</button>
                <button class="gallery-action-btn delete" title="Supprimer" onclick="event.stopPropagation(); window.deleteGalleryImage('${path.replace(/\\/g, '\\\\')}')">🗑️</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--danger); text-align: center; padding: 20px;">Erreur : ${err}</div>`;
    }
  }

  window.openLightbox = (url, path) => {
    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    const info = document.getElementById('lightbox-info');
    
    img.src = url;
    info.innerText = `Fichier : ${path.split('/').pop()}`;
    lb.classList.add('open');
  };

  window.closeLightbox = () => {
    document.getElementById('lightbox').classList.remove('open');
  };

  window.deleteGalleryImage = async (path) => {
    if (confirm("Voulez-vous vraiment supprimer cette œuvre de votre galerie ?")) {
      try {
        await invoke('delete_gallery_image', { path });
        await loadGallery();
        window.closeLightbox();
      } catch (err) {
        alert("Erreur lors de la suppression : " + err);
      }
    }
  };

  // Event Listeners Lightbox
  const lbClose = document.getElementById('lightbox-close');
  if (lbClose) lbClose.addEventListener('click', window.closeLightbox);
  
  const lbOverlay = document.getElementById('lightbox');
  if (lbOverlay) lbOverlay.addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') window.closeLightbox();
  });

  document.getElementById('settings-provider').addEventListener('change', () => {
    updateSettingsVisibility();
    updateModelSelect();
  });

  function updateSettingsVisibility() {
    const provider = document.getElementById('settings-provider').value;
    const groups = {
      'ollama': 'group-ollama',
      'lmstudio': 'group-lmstudio',
      'openai': 'group-openai',
      'gemini': 'group-gemini',
      'openrouter': 'group-openrouter',
      'anthropic': 'group-anthropic'
    };

    Object.keys(groups).forEach(key => {
      const el = document.getElementById(groups[key]);
      if (el) el.style.display = (provider === key) ? 'flex' : 'none';
    });
  }

  async function updateModelSelect() {
    const provider = document.getElementById('settings-provider').value;
    const modelSelect = document.getElementById('settings-model');
    modelSelect.innerHTML = '<option>Chargement...</option>';

    let options = [];
    if (provider === 'ollama') {
      try {
        const models = await invoke('list_ollama_models');
        options = models.map(m => ({ id: m, name: m }));
      } catch {
        options = [{ id: 'llama3', name: 'llama3 (fallback)' }];
      }
    } else if (provider === 'openai') {
      options = [
        { id: 'gpt-4o', name: 'GPT-4o (Recommandé)' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' }
      ];
    } else if (provider === 'gemini') {
      options = [
        { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash (Rapide)' },
        { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (Puissant)' }
      ];
    } else if (provider === 'openrouter') {
      options = [
        { id: 'openrouter/free', name: 'Auto-Router (Meilleur GRATUIT)' },
        { id: 'meta-llama/llama-3.1-8b-instruct:free', name: 'Llama 3.1 8B (GRATUIT)' },
        { id: 'mistralai/mistral-7b-instruct:free', name: 'Mistral 7B (GRATUIT)' },
        { id: 'microsoft/phi-3-mini-128k-instruct:free', name: 'Phi-3 Mini (GRATUIT)' },
        { id: 'google/gemini-flash-1.5', name: 'Gemini 1.5 Flash (Peu coûteux)' },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' }
      ];
    } else if (provider === 'lmstudio') {
      try {
        const models = await invoke('list_lmstudio_models');
        options = models.map(m => ({ id: m, name: m }));
      } catch {
        options = [{ id: 'local-model', name: 'local-model (fallback)' }];
      }
    } else if (provider === 'anthropic') {
      options = [
        { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-opus-latest', name: 'Claude 3 Opus' }
      ];
    }

    modelSelect.innerHTML = options.map(o => 
      `<option value="${o.id}" ${appConfig.preferred_models?.[provider] === o.id ? 'selected' : ''}>${o.name}</option>`
    ).join('');
  }

  window.testApiKey = async (provider) => {
    const key = document.getElementById(`settings-${provider}-key`).value;
    if (!key) return alert("Veuillez entrer une clé d'abord.");

    const btn = event.target;
    const originalText = btn.innerText;
    btn.innerText = "⏳...";
    btn.disabled = true;

    try {
      // Test léger : demander la liste des modèles ou un ping simple
      let url = "";
      if (provider === 'openai') url = "https://api.openai.com/v1/models";
      else if (provider === 'openrouter') url = "https://openrouter.ai/api/v1/models";
      else if (provider === 'gemini') url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
      
      if (provider === 'gemini') {
          const res = await fetch(url);
          if (res.ok) alert("✅ Clé Gemini valide !");
          else throw new Error("Invalide");
      } else {
          const res = await fetch(url, { headers: { "Authorization": `Bearer ${key}` } });
          if (res.ok) alert(`✅ Clé ${provider} valide !`);
          else throw new Error("Invalide");
      }
    } catch (e) {
      alert(`❌ Erreur : La clé ${provider} semble invalide.`);
    } finally {
      btn.innerText = originalText;
      btn.disabled = false;
    }
  };

  function populateShortcutSelects() {
    const selects = [1, 2, 3].map(i => document.getElementById(`shortcut-${i}`));
    selects.forEach((select, idx) => {
      select.innerHTML = '<option value="">Aucun</option>' + 
        agents.map(a => `<option value="${a.id}" ${appConfig.custom_shortcuts?.[idx+1] === a.id ? 'selected' : ''}>${a.name}</option>`).join('');
    });
  }

  window.saveSettings = async () => {
    appConfig.default_provider = document.getElementById('settings-provider').value;
    appConfig.ollama_url = document.getElementById('settings-ollama-url').value || 'http://localhost:11434';
    appConfig.lmstudio_url = document.getElementById('settings-lmstudio-url').value || 'http://localhost:1234';
    appConfig.openai_api_key = document.getElementById('settings-openai-key').value;
    appConfig.gemini_api_key = document.getElementById('settings-gemini-key').value;
    appConfig.openrouter_api_key = document.getElementById('settings-openrouter-key').value;
    appConfig.anthropic_api_key = document.getElementById('settings-anthropic-key').value;
    
    // Sauvegarder le modèle préféré
    if (!appConfig.preferred_models) appConfig.preferred_models = {};
    appConfig.preferred_models[appConfig.default_provider] = document.getElementById('settings-model').value;

    appConfig.font_family = document.getElementById('settings-font-family').value;
    appConfig.font_size = document.getElementById('settings-font-size').value;
    const tooltipModeEl = document.getElementById('settings-tooltip-mode');
    if (tooltipModeEl) appConfig.tooltip_mode = tooltipModeEl.value;
    normalizeMcpServers();
    
    appConfig.custom_shortcuts = {
      '1': document.getElementById('shortcut-1').value,
      '2': document.getElementById('shortcut-2').value,
      '3': document.getElementById('shortcut-3').value
    };

    applyTypography();
    applyTooltipMode();
    await invoke('save_config', { config: appConfig });
    await invoke('save_mcp_servers', { servers: appConfig.mcp_servers || [] }).catch(() => {});
    setTimeout(() => {
      loadMcpTools();
    }, 0);
    
    settingsPanel.classList.remove('open');
    ollamaAvailable = await invoke('check_ollama').catch(() => false);
    updateSystemStatus();
  };

  document.getElementById('settings-save').addEventListener('click', window.saveSettings);
  document.getElementById('settings-close').addEventListener('click', () => {
    settingsPanel.classList.remove('open');
  });

  // --- Knowledge Base (RAG) ---
  document.getElementById('select-folder-btn').addEventListener('click', async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Sélectionner un dossier projet'
      });

      if (selected) {
        selectedFolderPath = selected;
        const statusEl = document.getElementById('selected-folder-path');
        statusEl.innerText = "⚡ Indexation en cours...";
        
        try {
          indexedFiles = await invoke('index_directory', { path: selected });
          statusEl.innerText = `✅ ${indexedFiles.length} fichiers indexés : ${selected}`;
          
          const kbBadge = document.getElementById('kb-source-badge');
          const folderName = selected.split('/').pop() || selected;
          kbBadge.innerText = `📚 Source : ${folderName}`;
          kbBadge.style.display = 'inline-flex';
          kbBadge.title = selected;
        } catch (idxErr) {
          console.error("Indexation failed:", idxErr);
          statusEl.innerText = "❌ Échec de l'indexation.";
        }
      }
    } catch (err) {
      console.error("Erreur sélection dossier:", err);
      alert("Impossible d'accéder au dossier.");
    }
  });

  document.getElementById('stop-btn').addEventListener('click', async () => {
    await invoke('stop_generation');
    
    // Réinitialiser la barre de progression
    if (topLoadingBar) {
      topLoadingBar.classList.remove('active');
      topLoadingBar.style.width = '0%';
    }
    
    document.getElementById('stop-btn').style.display = 'none';
    document.getElementById('send-btn').style.display = 'flex';
  });

  const helpPanel = document.getElementById('help-panel');
  document.getElementById('help-btn').addEventListener('click', () => {
    helpPanel.classList.add('open');
  });
  document.getElementById('help-close').addEventListener('click', () => {
    helpPanel.classList.remove('open');
  });
}

init();
