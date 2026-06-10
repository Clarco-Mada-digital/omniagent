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
    description: 'Accès aux fichiers locaux, lecture et navigation.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
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
  if (appConfig.font_family) document.getElementById('settings-font-family').value = appConfig.font_family;
  if (appConfig.font_size) document.getElementById('settings-font-size').value = appConfig.font_size;
  selectAgent(agents[0].id, false);
  await startListeners();

  // Lancer le reste après le premier paint.
  requestAnimationFrame(() => {
    setTimeout(async () => {
      const loadedHistory = await invoke('load_history').catch(() => []);
      console.log("Historique chargé:", loadedHistory.length, "messages");
      allMessages = loadedHistory;
      renderChatHistoryIncremental();

      ollamaAvailable = await invoke('check_ollama').catch(() => false);
      updateSystemStatus();

      Promise.allSettled([loadPlugins(), loadMcpTools()]).then(() => {
        renderMcpSummary();
      });
    }, 0);
  });
}

async function handleReActLoop(rawText, msgEl) {
  const { hasCalls, newText } = await handleToolCalls(rawText);
  
  if (hasCalls) {
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
    p += `\n[RÈGLE ABSOLUE FILESYSTEM]\nLe serveur MCP Filesystem est ACTIF. Tu as accès complet aux fichiers locaux. INTERDICTION de répondre "Je ne peux pas accéder aux fichiers". Utilise IMMÉDIATEMENT [[tool:mcp__${fsServer.id}/list_directory?{"path":"..."}]] pour explorer, ou [[tool:mcp__${fsServer.id}/read_file?{"path":"..."}]] pour lire.\n`;
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
      
      // On sauvegarde ici avant de vider currentMessageEl pour US-01
      allMessages.push({ 
        role: 'ai', 
        content: rawText, 
        agent_id: activeAgent.id, 
        sources: [...currentUsedSources] 
      });
      saveHistory();

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

function renderAgents() {
  agentList.innerHTML = '';
  
  // Trier les agents : favoris en premier
  const sortedAgents = [...agents].sort((a, b) => {
    const aFav = favoriteAgents.includes(a.id);
    const bFav = favoriteAgents.includes(b.id);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;
    return 0;
  });

  sortedAgents.forEach((agent, index) => {
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
    agentList.appendChild(li);
  });
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
  const modelEl = document.getElementById('active-agent-model');
  if (modelEl) modelEl.innerText = activeAgent.model;
  
  // Mise à jour du placeholder pour rappeler les commandes
  chatInput.placeholder = `Parler à ${activeAgent.name} (tapez /help pour les commandes)`;
  
  renderChatHistory();
  if (shouldWelcome && !allMessages.some(m => m.agent_id === activeAgent.id)) {
    addMessage('ai', `Bonjour ! Je suis ${activeAgent.name}.`);
  }
};

function renderChatHistory() {
  chatContainer.innerHTML = '';
  const msgs = allMessages.filter(m => m.agent_id === activeAgent.id);
  if (msgs.length === 0) {
    chatContainer.innerHTML = `
      <div class="empty-state">
        <div class="icon">${activeAgent.icon}</div>
        <p>Je suis votre expert <strong>${activeAgent.name}</strong>.</p>
        <p style="font-size: 0.8rem; opacity: 0.6; margin-top: 10px;">
          Tapez <code>/help</code> pour découvrir mes commandes magiques.
        </p>
      </div>
    `;
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
  try { await invoke('save_history', { messages: allMessages }); } catch (e) { console.error(e); }
}

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

  // Mettre à jour le badge après envoi
  updateCommandBadge();

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
    return;
  }

  const fullPromptToSend = text;
  const userVisibleText = displayContent || text;

  chatInput.value = '';
  chatInput.style.height = 'auto';
  document.getElementById('send-btn').style.display = 'none';
  document.getElementById('stop-btn').style.display = 'flex';
  
  if (!isAutoResponse) {
    addMessage('user', userVisibleText, [...attachedImages], true, cmd_used);
  }

  // Générer un ID de requête unique
  currentRequestId = Math.random().toString(36).substring(2, 15);

  currentMessageEl = document.createElement('div');
  currentMessageEl.className = 'typing-indicator';
  currentMessageEl.innerHTML = '<span></span><span></span><span></span>';
  chatContainer.appendChild(currentMessageEl);
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
        // Fallback intelligent si le modèle de l'agent n'existe pas en local
        let modelToUse = activeAgent.model;
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
        // Fallback intelligent pour LM Studio
        let modelToUse = activeAgent.model;
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
  
  let displayModel = appConfig.preferred_models[provider] || activeAgent.model;
  
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
    chatContainer.innerHTML = `<div class="empty-state"><div class="icon">${activeAgent.icon}</div><p>Historique effacé.</p></div>`;
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
    normalizeMcpServers();
    
    appConfig.custom_shortcuts = {
      '1': document.getElementById('shortcut-1').value,
      '2': document.getElementById('shortcut-2').value,
      '3': document.getElementById('shortcut-3').value
    };

    applyTypography();
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
