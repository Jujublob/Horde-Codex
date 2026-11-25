import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = path.join(os.homedir(), '.horde-cli-memoire');
const CONVOS_FILE = path.join(DATA_DIR, 'convos_meta.json');
const SHARED_MEMORY_FILE = path.join(DATA_DIR, 'agents_shared.json');

// Création du dossier de données s'il n'existe pas
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function loadConvosMeta() {
    try {
        return JSON.parse(fs.readFileSync(CONVOS_FILE, 'utf-8'));
    } catch {
        return { nextId: 1, list: [] };
    }
}

function saveConvosMeta(meta) {
    fs.writeFileSync(CONVOS_FILE, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

export function getNextConvId() {
    const meta = loadConvosMeta();
    const id = meta.nextId;
    meta.nextId += 1;
    saveConvosMeta(meta);
    return id;
}

export function memoryPath(convId) {
    return path.join(DATA_DIR, `convo_${convId}.json`);
}

export function globalMemoryPath() {
    return path.join(DATA_DIR, 'global.json');
}

export function sharedMemoryPath() {
    return SHARED_MEMORY_FILE;
}

export function readSharedMemory() {
    try {
        return fs.readFileSync(SHARED_MEMORY_FILE, 'utf-8');
    } catch {
        return '';
    }
}

export function appendToSharedMemory(agentId, action) {
    const timestamp = new Date().toLocaleString('fr-FR');
    const entry = `[${timestamp}] Agent ${agentId}: ${action}\n`;
    fs.appendFileSync(SHARED_MEMORY_FILE, entry, { mode: 0o600 });
}

export function clearSharedMemory() {
    if (fs.existsSync(SHARED_MEMORY_FILE)) {
        fs.writeFileSync(SHARED_MEMORY_FILE, '', { mode: 0o600 });
    }
}

export function getConversation(convId) {
    const p = memoryPath(convId);
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}

export function saveConversation(convId, data) {
    const p = memoryPath(convId);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function addMessage(convId, role, content) {
    const data = getConversation(convId) || { messages: [] };
    data.messages.push({ role, content, timestamp: new Date().toISOString() });
    saveConversation(convId, data);
}
