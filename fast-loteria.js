const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const fs = require('fs');

// Puzzle #73
const TARGET_ADDRESS = "12VVRNPi4SJqUTsp6FmqDqY5sGosDtysn4";
const TARGET_PUBKEY = "032b7b9e07f8ea0c8f9cbf4dfca6d2c8b163e6f0b49f09b7c73636b6d9142c9c0f";
const RANGE_START = BigInt("0x1000000000000000000"); // 2^72
const RANGE_END = BigInt("0x1ffffffffffffffffff");   // 2^73-1

// Filtros de padrões (mantém o código rápido)
function isSuspiciousPattern(hexKey) {
  // 1. Muitos caracteres repetidos (ex: AAAAAAAAA...)
  if (/(.)\1{20,}/.test(hexKey)) return true;
  
  // 2. Sequências (123456789abcdef...)
  if (hexKey.includes('0123456789abcdef') || 
      hexKey.includes('fedcba9876543210')) return true;
  
  // 3. Padrões comuns (deadbeef, cafebabe, etc)
  if (hexKey.includes('deadbeef') || 
      hexKey.includes('cafebabe') || 
      hexKey.includes('00000000') ||
      hexKey.includes('ffffffff')) return true;
  
  // 4. Muitos zeros no início/fim
  if (hexKey.startsWith('000000') || hexKey.endsWith('000000')) return true;
  
  // 5. Palíndromos simples (verifica só os primeiros/last 16 chars)
  const first16 = hexKey.substring(0, 16);
  const last16 = hexKey.substring(48, 64);
  if (first16 === last16.split('').reverse().join('')) return true;
  
  return false;
}

// Verifica baixa entropia (versão simples)
function isLowEntropy(hexKey) {
  // Conta caracteres únicos
  const unique = new Set(hexKey).size;
  if (unique < 8) return true; // Muito poucos caracteres diferentes
  
  // Verifica se algum caractere aparece muito
  const counts = {};
  for (const char of hexKey) {
    counts[char] = (counts[char] || 0) + 1;
  }
  for (const char in counts) {
    if (counts[char] > hexKey.length * 0.4) return true; // >40% é suspeito
  }
  
  return false;
}

// Telegram alert
function sendAlert(privKey) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  
  const message = `🚀 PUZZLE 73 ENCONTRADO! ${privKey}`;
  require('child_process').exec(
    `curl -s -X POST https://api.telegram.org/bot${token}/sendMessage -d chat_id=${chatId} -d text="${message}"`
  );
}

if (isMainThread) {
  // Lê último ponto salvo
  let startKey;
  try {
    const saved = fs.readFileSync('last_key.txt', 'utf8').trim();
    startKey = BigInt(saved);
    console.log(`🔁 Retomando de: 0x${startKey.toString(16)}`);
  } catch (e) {
    startKey = RANGE_START;
    console.log(`🚀 Iniciando do começo: 0x${startKey.toString(16)}`);
  }
  
  const numThreads = require('os').cpus().length;
  let totalChecked = 0;
  const startTime = Date.now();
  
  // Divide o trabalho
  for (let i = 0; i < numThreads; i++) {
    const worker = new Worker(__filename, {
      workerData: {
        workerId: i,
        startKey: (startKey + BigInt(i * 1000000)).toString(16), // Cada worker começa diferente
        targetPubKey: TARGET_PUBKEY
      }
    });
    
    worker.on('message', (msg) => {
      if (msg.found) {
        console.log(`\n🎉 CHAVE ENCONTRADA pelo Worker ${msg.workerId}!`);
        console.log(`🔑 ${msg.privateKey}`);
        fs.writeFileSync('FOUND.txt', msg.privateKey);
        sendAlert(msg.privateKey);
        process.exit(0);
      }
      
      if (msg.progress) {
        totalChecked += msg.checked;
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = Math.floor(totalChecked / elapsed);
        process.stdout.write(`\r⚡ ${speed.toLocaleString()}/s | Total: ${totalChecked.toLocaleString()} | Padrões: ${msg.patterns}`);
        
        // Salva progresso a cada 100k chaves
        if (msg.lastKey) {
          fs.writeFileSync('last_key.txt', BigInt('0x' + msg.lastKey).toString());
        }
      }
    });
  }
  
  // Salva ao sair
  process.on('SIGINT', () => {
    console.log('\n💾 Salvando progresso...');
    process.exit(0);
  });
  
} else {
  // Worker thread
  const { workerId, startKey, targetPubKey } = workerData;
  let currentKey = BigInt('0x' + startKey);
  const targetBuffer = Buffer.from(targetPubKey, 'hex');
  let patternsFound = 0;
  let batchCounter = 0;
  
  while (true) {
    // Gera chave hex (sempre 64 chars)
    let hexKey = currentKey.toString(16).padStart(64, '0');
    if (hexKey.length > 64) hexKey = hexKey.slice(-64);
    
    // FILTRO RÁPIDO: Só verifica se for padrão suspeito OU baixa entropia
    const isPattern = isSuspiciousPattern(hexKey);
    const isLowEnt = isLowEntropy(hexKey);
    
    if (isPattern || isLowEnt) {
      patternsFound++;
      
      try {
        // Só calcula chave pública se passou no filtro
        const privBuffer = Buffer.from(hexKey, 'hex');
        const pubKey = secp256k1.publicKeyCreate(privBuffer, true);
        
        if (Buffer.compare(pubKey, targetBuffer) === 0) {
          parentPort.postMessage({
            found: true,
            workerId: workerId,
            privateKey: hexKey
          });
          break;
        }
      } catch (e) {
        // Chave inválida, continua
      }
    }
    
    currentKey++;
    batchCounter++;
    
    // Reporta progresso a cada 1000 chaves
    if (batchCounter >= 1000) {
      parentPort.postMessage({
        progress: true,
        workerId: workerId,
        checked: batchCounter,
        patterns: patternsFound,
        lastKey: currentKey.toString(16)
      });
      batchCounter = 0;
    }
    
    // Para se chegou muito longe (safety)
    if (currentKey > RANGE_END) {
      parentPort.postMessage({
        progress: true,
        workerId: workerId,
        checked: batchCounter,
        patterns: patternsFound,
        done: true
      });
      break;
    }
  }
}
