const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');

// CONFIGURAÇÃO DO PUZZLE 73
const TARGET_ADDRESS = "12VVRNPi4SJqUTsp6FmqDqY5sGosDtysn4";
const TARGET_PUBKEY = "032b7b9e07f8ea0c8f9cbf4dfca6d2c8b163e6f0b49f09b7c73636b6d9142c9c0f";
const RANGE_START = BigInt("0x1000000000000000000"); // 2^72
const RANGE_END = BigInt("0x1ffffffffffffffffff");   // 2^73-1

// Telegram config
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ==================== FILTROS INTELIGENTES ====================

// Detecta padrões suspeitos (rápido)
function isSuspiciousPattern(hexKey) {
    // 1. Padrões de repetição (ex: AAAAA...)
    if (/(.)\1{15,}/.test(hexKey)) return true;
    
    // 2. Sequências simples
    if (hexKey.includes('0123456789abcdef') || 
        hexKey.includes('fedcba9876543210') ||
        hexKey.includes('1234567890abcdef')) return true;
    
    // 3. Padrões conhecidos (deadbeef, cafebabe, etc)
    const knownPatterns = [
        'deadbeef', 'cafebabe', '00000000', 'ffffffff',
        'aaaaaaaa', '55555555', '33333333', 'cccccccc'
    ];
    for (const pattern of knownPatterns) {
        if (hexKey.includes(pattern)) return true;
    }
    
    // 4. Muitos zeros ou Fs no início/fim
    if (/^0{12,}/.test(hexKey) || /f{12,}$/.test(hexKey)) return true;
    
    // 5. Padrão alternante (ababab...)
    if (/^(ab|cd|ef|01){16,}/.test(hexKey)) return true;
    
    return false;
}

// Verifica entropia baixa (simples e rápido)
function isLowEntropy(hexKey) {
    // Conta caracteres únicos
    const unique = new Set(hexKey).size;
    if (unique < 10) return true; // Muito pouca variedade
    
    // Verifica distribuição (se algum char domina)
    const charCount = {};
    for (const char of hexKey) {
        charCount[char] = (charCount[char] || 0) + 1;
        if (charCount[char] > hexKey.length * 0.3) return true; // >30% é suspeito
    }
    
    return false;
}

// Notificação Telegram
function sendAlert(privateKey) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    
    const message = `🚀 BITCOIN PUZZLE 73 RESOLVIDO!\n\n🔑 ${privateKey}\n📭 ${TARGET_ADDRESS}`;
    const cmd = `curl -s -X POST https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage -d chat_id=${TELEGRAM_CHAT_ID} -d text="${message}"`;
    
    exec(cmd, (error) => {
        if (!error) console.log("\n✅ Alerta enviado para Telegram!");
    });
}

// ==================== WORKER THREAD ====================

if (isMainThread) {
    // Carrega progresso salvo
    let startKey;
    try {
        const saved = fs.readFileSync('last_key.txt', 'utf8').trim();
        startKey = BigInt(saved);
        console.log(`\x1b[32m[RETOMANDO]\x1b[0m 0x${startKey.toString(16)}`);
    } catch (e) {
        startKey = RANGE_START;
        console.log(`\x1b[33m[INICIANDO]\x1b[0m 0x${startKey.toString(16)}`);
    }
    
    // Configura workers (um por CPU)
    const numCPUs = os.cpus().length;
    let totalChecked = 0;
    let patternsFound = 0;
    const startTime = Date.now();
    let lastSavedKey = startKey;
    
    console.log(`\x1b[36m[INFO]\x1b[0m Usando ${numCPUs} CPUs`);
    console.log(`\x1b[36m[INFO]\x1b[0m Alvo: ${TARGET_ADDRESS}`);
    console.log('─'.repeat(60));
    
    for (let i = 0; i < numCPUs; i++) {
        // Cada worker pega um pedaço do range
        const workerStart = startKey + (BigInt(i) * BigInt(10000000));
        const workerEnd = workerStart + BigInt(1000000000); // 1 bilhão de chaves
        
        const worker = new Worker(__filename, {
            workerData: {
                workerId: i,
                startKey: workerStart.toString(16),
                endKey: workerEnd > RANGE_END ? RANGE_END.toString(16) : workerEnd.toString(16),
                targetPubKey: TARGET_PUBKEY
            }
        });
        
        worker.on('message', (msg) => {
            if (msg.type === 'found') {
                console.log(`\n\x1b[1;32m🎉 CHAVE ENCONTRADA!\x1b[0m`);
                console.log(`\x1b[32mWorker ${msg.workerId}: ${msg.privateKey}\x1b[0m`);
                
                // Salva em arquivo
                fs.writeFileSync('FOUND_KEY.txt', msg.privateKey);
                fs.appendFileSync('history.txt', 
                    `[${new Date().toISOString()}] ${msg.privateKey}\n`);
                
                // Notifica
                sendAlert(msg.privateKey);
                
                // Mata todos workers
                process.exit(0);
            }
            
            if (msg.type === 'stats') {
                totalChecked += msg.checked;
                patternsFound += msg.patterns;
                
                // Atualiza última chave para salvar progresso
                if (msg.lastKey) {
                    const keyNum = BigInt('0x' + msg.lastKey);
                    if (keyNum > lastSavedKey) lastSavedKey = keyNum;
                }
                
                // Display progresso
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = Math.floor(totalChecked / elapsed);
                const hours = (elapsed / 3600).toFixed(2);
                
                process.stdout.write(
                    `\r\x1b[36m[STATS]\x1b[0m ` +
                    `⏱️ ${hours}h | ` +
                    `🔍 ${totalChecked.toLocaleString()} | ` +
                    `🎯 ${patternsFound.toLocaleString()} padrões | ` +
                    `⚡ ${speed.toLocaleString()}/s`
                );
            }
        });
        
        worker.on('exit', (code) => {
            if (code !== 0) console.log(`\nWorker ${i} saiu com código ${code}`);
        });
    }
    
    // Salva progresso periodicamente
    setInterval(() => {
        fs.writeFileSync('last_key.txt', lastSavedKey.toString());
    }, 30000); // A cada 30 segundos
    
    // Salva ao sair
    process.on('SIGINT', () => {
        console.log('\n💾 Salvando progresso...');
        fs.writeFileSync('last_key.txt', lastSavedKey.toString());
        process.exit(0);
    });
    
} else {
    // ==================== CÓDIGO DO WORKER ====================
    const { workerId, startKey, endKey, targetPubKey } = workerData;
    let currentKey = BigInt('0x' + startKey);
    const maxKey = BigInt('0x' + endKey);
    const targetBuffer = Buffer.from(targetPubKey, 'hex');
    
    let batchCounter = 0;
    let patternsFound = 0;
    const BATCH_SIZE = 5000; // Relatórios a cada 5k chaves
    
    while (currentKey <= maxKey) {
        // Converte para hex (sempre 64 caracteres)
        let hexKey = currentKey.toString(16).padStart(64, '0');
        if (hexKey.length > 64) hexKey = hexKey.slice(-64);
        
        // FILTRO INTELIGENTE: Só processa se for suspeito
        const isPattern = isSuspiciousPattern(hexKey);
        const isLowEnt = isLowEntropy(hexKey);
        
        if (isPattern || isLowEnt) {
            patternsFound++;
            
            try {
                // Tenta gerar chave pública
                const privBuffer = Buffer.from(hexKey, 'hex');
                const pubKey = secp256k1.publicKeyCreate(privBuffer, true);
                
                // Verifica se é a chave alvo
                if (pubKey.equals(targetBuffer)) {
                    parentPort.postMessage({
                        type: 'found',
                        workerId: workerId,
                        privateKey: hexKey
                    });
                    return;
                }
            } catch (e) {
                // Chave inválida, continua
            }
        }
        
        currentKey++;
        batchCounter++;
        
        // Envia estatísticas periodicamente
        if (batchCounter >= BATCH_SIZE) {
            parentPort.postMessage({
                type: 'stats',
                workerId: workerId,
                checked: batchCounter,
                patterns: patternsFound,
                lastKey: currentKey.toString(16)
            });
            batchCounter = 0;
            patternsFound = 0;
        }
    }
    
    // Worker terminou seu intervalo
    parentPort.postMessage({
        type: 'stats',
        workerId: workerId,
        checked: batchCounter,
        patterns: patternsFound,
        done: true
    });
}
