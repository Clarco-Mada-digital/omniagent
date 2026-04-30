import { agents } from './agents.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
// Support pour Tauri v2 : le plugin dialog peut être sur .dialog ou .pluginDialog
const dialog = window.__TAURI__.dialog || window.__TAURI__.pluginDialog;
const open = dialog ? dialog.open : null;

let activeAgent = agents[0];
let allMessages = [];
let appConfig = { 
  openai_api_key: null, 
  anthropic_api_key: null, 
  gemini_api_key: null,
  openrouter_api_key: null,
  default_provider: 'ollama',
  preferred_models: {
    ollama: 'llama3',
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
let attachedFile = null; // { name: string, content: string }
let attachedImages = []; // Array of base64 strings
let indexedFiles = []; // Array of { name, path, content }
let selectedFolderPath = null;
let favoriteAgents = []; // Array of agent IDs
let currentUsedSources = []; // Pour l'affichage des sources RAG


const chatContainer = document.getElementById('chat-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const agentList = document.getElementById('agent-list');
const activeAgentName = document.getElementById('active-agent-name');
const activeAgentDesc = document.getElementById('active-agent-desc');
const ollamaStatus = document.getElementById('ollama-status');
const settingsPanel = document.getElementById('settings-panel');

let currentMessageEl = null;

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

async function init() {
  renderAgents();
  setupEventListeners();

  // Charger la config et l'historique en parallèle
  const [loadedConfig, loadedHistory] = await Promise.all([
    invoke('load_config').catch(() => ({})),
    invoke('load_history').catch(() => [])
  ]);
  
  // Fusionner pour garder les valeurs par défaut (ex: preferred_models initiaux)
  appConfig = { 
      ...appConfig, 
      ...loadedConfig,
      // S'assurer que les preferred_models sont fusionnés s'ils existent partiellement
      preferred_models: { ...appConfig.preferred_models, ...(loadedConfig.preferred_models || {}) }
  };
  
  allMessages = loadedHistory;
  favoriteAgents = appConfig.favorites || [];

  // Vérifier si Ollama est disponible
  ollamaAvailable = await invoke('check_ollama').catch(() => false);
  updateSystemStatus();
  applyTypography();
  
  if (appConfig.font_family) document.getElementById('settings-font-family').value = appConfig.font_family;
  if (appConfig.font_size) document.getElementById('settings-font-size').value = appConfig.font_size;

  selectAgent(agents[0].id, false);

  // Écouter les chunks de réponse (même canal pour Ollama et Cloud)
  await listen('ollama-chunk', (event) => {
    const { chunk, done } = event.payload;
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
      currentMessageEl.dataset.raw += contentToAppend;
      currentMessageEl.innerHTML = marked.parse(currentMessageEl.dataset.raw);
      
      // Highlight code blocks
      currentMessageEl.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
      });
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    
    if (done) {
      document.getElementById('stop-btn').style.display = 'none';
      document.getElementById('send-btn').style.display = 'flex';
      allMessages.push({ 
        role: 'ai', 
        content: currentMessageEl.dataset.raw, 
        agent_id: activeAgent.id,
        sources: [...currentUsedSources]
      });
      
      if (currentUsedSources.length > 0) {
        renderSourcesBadge(currentMessageEl.parentElement, currentUsedSources);
      }
      
      currentUsedSources = []; // Reset
      saveHistory();
      currentMessageEl = null; // Important: Empêcher les doublons si plusieurs events 'done' arrivent
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

window.selectAgent = (id, shouldWelcome = true) => {
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
    const el = addMessage(m.role, m.content, m.images, false, m.cmdUsed);
    if (m.sources && m.sources.length > 0) {
      renderSourcesBadge(el.closest('.message-wrapper'), m.sources);
    }
  });
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

function addMessage(role, text, images = null, shouldSave = true, cmdUsed = null) {
  // Enlever l'état vide si présent
  const emptyState = chatContainer.querySelector('.empty-state');
  if (emptyState) chatContainer.removeChild(emptyState);

  const msgWrapper = document.createElement('div');
  msgWrapper.className = `message-wrapper ${role}`;

  const msgEl = document.createElement('div');
  msgEl.className = `message ${role}`;
  
  // Badge de commande magique
  if (cmdUsed) {
    const cmdBadge = document.createElement('span');
    cmdBadge.className = 'msg-cmd-badge';
    cmdBadge.innerText = `via ${cmdUsed}`;
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
      cmdUsed: cmdUsed 
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
    const imageUrl = await invoke('generate_image', {
      api_key: appConfig.openai_api_key,
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

async function sendMessage() {
  let text = chatInput.value.trim();
  if (!text) return;

  let displayContent = null;
  let cmdUsed = null;

  // --- Système de Slash Commands ---
  if (text.startsWith('/')) {
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
      cmdUsed = cmd;
    } else if (activeAgent.id === 'translator' && cmd.length === 3) {
      const langCode = cmd.substring(1);
      text = `Traduis précisément ce texte vers la langue correspondant au code "${langCode}" : \n---\n${content}\n---`;
      displayContent = content;
      cmdUsed = cmd;
    }
  }

  // Masquer le badge après envoi
  const badgeEl = document.getElementById('active-command-badge');
  if (badgeEl) badgeEl.style.display = 'none';

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
  
  addMessage('user', userVisibleText, [...attachedImages], true, cmdUsed);

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
    const agentMessages = allMessages.filter(m => m.agent_id === activeAgent.id).slice(-6);
    const context = agentMessages.map(m => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'}: ${m.content}`).join('\n');

    let fullPrompt = `${activeAgent.systemPrompt}\n\n`;

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

    fullPrompt += `Historique:\n${context}\n\n`;
    
    if (fileToSend) {
      fullPrompt += `FICHIER JOINT (${fileToSend.name}) :\n---\n${fileToSend.content}\n---\n\n`;
    }

    fullPrompt += `Utilisateur: ${text}\n\nAssistant:`;

    if (provider === 'ollama') {
      await invoke('ask_ollama_stream', { 
        model: activeAgent.model, 
        prompt: `${fullPrompt}${fullPromptToSend}`,
        images: imagesToSend
      });
    } else if (provider !== 'none') {
      const apiKey = getApiKeyForProvider(provider);
      if (!apiKey) {
        throw new Error(`Clé API manquante pour le fournisseur ${provider}.`);
      }

      const badge = document.createElement('span');
      badge.className = 'cloud-badge';
      
      let displayModel = appConfig.preferred_models[provider] || activeAgent.model;
      
      if (provider === 'openai') { badge.innerText = '☁ OpenAI'; }
      else if (provider === 'gemini') { badge.innerText = '✨ Gemini'; }
      else if (provider === 'openrouter') { badge.innerText = '🌐 OpenRouter'; }
      else if (provider === 'anthropic') { badge.innerText = '🦉 Anthropic'; }
      
      chatContainer.appendChild(badge);

      await invoke('ask_cloud_stream', {
        provider: provider,
        apiKey: apiKey,
        model: displayModel,
        systemPrompt: activeAgent.systemPrompt,
        userMessage: fullPromptToSend,
        images: imagesToSend
      });
    } else {
      currentMessageEl.className = 'message ai';
      currentMessageEl.innerText = '⚠️ Aucun service IA disponible. Vérifiez Ollama ou ajoutez une clé API dans les paramètres.';
    }
  } catch (err) {

    if (currentMessageEl) {
      currentMessageEl.className = 'message ai';
      currentMessageEl.innerText = `Erreur: ${err}`;
    }
    console.error(err);
  }
}

window.exportChat = async (format) => {
  document.getElementById('export-menu').classList.remove('open');
  try {
    const savedPath = await invoke('export_conversation', {
      agentId: activeAgent.id,
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = (chatInput.scrollHeight) + 'px';

    // Détection de commande magique
    const val = chatInput.value;
    const badge = document.getElementById('active-command-badge');
    
    if (val.startsWith('/') && val.includes(' ')) {
      const cmd = val.split(' ')[0].toLowerCase();
      const agentCmd = activeAgent.commands?.find(c => c.cmd === cmd);
      
      if (agentCmd) {
        badge.innerHTML = `<span>✨ Action active :</span> ${agentCmd.desc}`;
        badge.style.display = 'flex';
      } else if (activeAgent.id === 'translator' && cmd.length === 3) {
        badge.innerHTML = `<span>🌍 Traduction :</span> ${cmd.substring(1).toUpperCase()}`;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    } else {
      badge.style.display = 'none';
    }
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
  });

  document.getElementById('settings-btn').addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    document.getElementById('settings-provider').value = appConfig.default_provider;
    document.getElementById('settings-openai-key').value = appConfig.openai_api_key || '';
    document.getElementById('settings-gemini-key').value = appConfig.gemini_api_key || '';
    document.getElementById('settings-openrouter-key').value = appConfig.openrouter_api_key || '';
    document.getElementById('settings-anthropic-key').value = appConfig.anthropic_api_key || '';
    
    updateSettingsVisibility();
    updateModelSelect();
    // Remplir les selects de raccourcis
    populateShortcutSelects();
  });

  // --- Galerie ---
  document.getElementById('gallery-btn').addEventListener('click', async () => {
    const galleryOverlay = document.getElementById('gallery-overlay');
    galleryOverlay.classList.add('open');
    await loadGallery();
  });

  async function loadGallery() {
    const grid = document.getElementById('gallery-grid');
    grid.innerHTML = '<p style="color: var(--text-muted); text-align: center; grid-column: 1 / -1;">Chargement de la galerie...</p>';
    
    try {
      const images = await invoke('list_gallery_images');
      if (images.length === 0) {
        grid.innerHTML = '<p style="color: var(--text-muted); text-align: center; grid-column: 1 / -1;">Aucune image générée pour le moment.</p>';
        return;
      }
      
      grid.innerHTML = images.map(path => {
        // Tauri permet de charger des fichiers locaux via asset:// ou custom protocol si configuré
        // Ici on utilise un chemin converti par Tauri
        const assetUrl = window.__TAURI__.tauri.convertFileSrc(path);
        return `
          <div style="position: relative; border-radius: 12px; overflow: hidden; border: 1px solid var(--glass-border); aspect-ratio: 1; cursor: pointer; transition: transform 0.2s;" 
               onclick="window.openPath('${path.replace(/\\/g, '\\\\')}')"
               onmouseover="this.style.transform='scale(1.03)'"
               onmouseout="this.style.transform='scale(1)'">
            <img src="${assetUrl}" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy" />
            <div style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.7); padding: 6px; font-size: 0.7rem; text-align: center;">Ouvrir localement</div>
          </div>
        `;
      }).join('');
    } catch (err) {
      grid.innerHTML = `<p style="color: #f87171; text-align: center; grid-column: 1 / -1;">Erreur lors du chargement : ${err}</p>`;
    }
  }

  document.getElementById('settings-provider').addEventListener('change', () => {
    updateSettingsVisibility();
    updateModelSelect();
  });

  function updateSettingsVisibility() {
    const provider = document.getElementById('settings-provider').value;
    const groups = {
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
    appConfig.openai_api_key = document.getElementById('settings-openai-key').value;
    appConfig.gemini_api_key = document.getElementById('settings-gemini-key').value;
    appConfig.openrouter_api_key = document.getElementById('settings-openrouter-key').value;
    appConfig.anthropic_api_key = document.getElementById('settings-anthropic-key').value;
    
    // Sauvegarder le modèle préféré
    if (!appConfig.preferred_models) appConfig.preferred_models = {};
    appConfig.preferred_models[appConfig.default_provider] = document.getElementById('settings-model').value;

    appConfig.font_family = document.getElementById('settings-font-family').value;
    appConfig.font_size = document.getElementById('settings-font-size').value;
    
    appConfig.custom_shortcuts = {
      '1': document.getElementById('shortcut-1').value,
      '2': document.getElementById('shortcut-2').value,
      '3': document.getElementById('shortcut-3').value
    };

    applyTypography();
    await invoke('save_config', { config: appConfig });
    
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
