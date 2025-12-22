const { Worker, isMainThread, parentPort } = require('worker_threads');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const os = require('os');
const { exec } = require('child_process');

// Configurações do Puzzle #73
const TARGET_PUBKEY_COMPRESSED = "03a7a4c30291ac1db24b4ab00c442aa832f7794b5a0959bec6e8d7fee802289dcd";
const RANGE_START = BigInt("0x200");
const RANGE_END = BigInt("0x3ff");
const RANGE_DIFF = RANGE_END - RANGE_START;

// Variáveis de Ambiente para segurança
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function sendAlert(privKey) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("\n⚠️ Telegram não configurado. Chave: " + privKey);
        return;
    }
    const message = `🚀 CHAVE ENCONTRADA (PUZZLE 73)! %0A%0APRIVADA: ${privKey}`;
    const cmd = `curl -s -X POST https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage -d chat_id=${TELEGRAM_CHAT_ID} -d text="${message}"`;
    
    exec(cmd, (err) => {
        if (err) console.error("\n❌ Erro ao enviar Telegram");
        else console.log("\n✅ Alerta enviado ao Telegram!");
    });
}

if (isMainThread) {
    const numCPUs = os.cpus().length;
    console.log(`\x1b[35m[SISTEMA]\x1b[0m Iniciando em ${numCPUs} núcleos...`);
    
    let totalChecked = 0;
    const startTime = Date.now();

    for (let i = 0; i < numCPUs; i++) {
        const worker = new Worker(__filename);
        worker.on('message', (msg) => {
            if (msg.type === 'found') {
                console.log(`\n\x1b[42m\x1b[30m !!! SUCESSO: ${msg.priv} !!! \x1b[0m`);
                sendAlert(msg.priv);
                setTimeout(() => process.exit(), 5000);
            }
            if (msg.type === 'stats') {
                totalChecked += msg.count;
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = Math.floor(totalChecked / elapsed);
                process.stdout.write(`\r\x1b[36m> Velocidade: ${speed.toLocaleString()} keys/s | Total: ${totalChecked.toLocaleString()}\x1b[0m`);
            }
        });
    }
} else {
    const targetBuf = Buffer.from(TARGET_PUBKEY_COMPRESSED, 'hex');
    let count = 0;
    const batchSize = 10000;

    while (true) {
        const privBuf = crypto.randomBytes(32);
        const privInt = (BigInt('0x' + privBuf.toString('hex')) % RANGE_DIFF) + RANGE_START;
        const finalPrivBuf = Buffer.from(privInt.toString(16).padStart(64, '0'), 'hex');

        try {
            const pubKey = secp256k1.publicKeyCreate(finalPrivBuf, true);
            if (Buffer.compare(pubKey, targetBuf) === 0) {
                parentPort.postMessage({ type: 'found', priv: finalPrivBuf.toString('hex') });
            }
        } catch (e) {}

        count++;
        if (count >= batchSize) {
            parentPort.postMessage({ type: 'stats', count: batchSize });
            count = 0;
        }
    }
}
