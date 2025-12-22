const { Worker, isMainThread, parentPort } = require('worker_threads');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const os = require('os');
const { exec } = require('child_process');

// Configurações do Puzzle #73
const TARGET_PUBKEY_COMPRESSED = "02145d2611c823a396ef6712ce0f712f09b9b4f3135e3e0aa3230fb9b6d08d1e16";
const RANGE_START = BigInt("0x4000000000000000000000000000000000");
const RANGE_END = BigInt("0x7fffffffffffffffffffffffffffffffff");
const RANGE_DIFF = RANGE_END - RANGE_START;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// VARIÁVEL DE TRAVA GLOBAL (Thread Principal)
let jaEnviouAlerta = false;

function sendAlert(privKey) {
    // Se já enviou uma vez nesta sessão, bloqueia as próximas
    if (jaEnviouAlerta) return;
    jaEnviouAlerta = true;

    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("\n⚠️ Telegram não configurado. Chave: " + privKey);
        return;
    }

    const message = `🚀 135: ${privKey}`;
    const cmd = `curl -s -X POST https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage -d chat_id=${TELEGRAM_CHAT_ID} -d text="${message}"`;
    
    exec(cmd, (err) => {
        if (err) {
            console.error("\n❌ Erro ao enviar Telegram");
            jaEnviouAlerta = false; // Permite tentar de novo apenas se deu erro no envio
        } else {
            console.log("\n✅ Alerta enviado com sucesso ao Telegram!");
            // Encerra tudo após o envio bem-sucedido
            setTimeout(() => process.exit(0), 2000);
        }
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
                // Chama a função de alerta que possui a trava
                sendAlert(msg.priv);
                // Comando imediato para parar de processar novas chaves
                console.log(`\n\x1b[42m\x1b[30m !!! ENCONTRADA: ${msg.priv} !!! \x1b[0m`);
            }
            if (msg.type === 'stats') {
                totalChecked += msg.count;
                // Reduzi a frequência de atualização do console para poupar processamento
                if (totalChecked % 50000 === 0) {
                    const elapsed = (Date.now() - startTime) / 1000;
                    const speed = Math.floor(totalChecked / elapsed);
                    process.stdout.write(`\r\x1b[36m> Velocidade: ${speed.toLocaleString()} keys/s | Total: ${totalChecked.toLocaleString()}\x1b[0m`);
                }
            }
        });
    }
} else {
    // Lógica dos Workers (Filhos)
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
                // Para o loop interno imediatamente após encontrar
                break; 
            }
        } catch (e) {}

        count++;
        if (count >= batchSize) {
            parentPort.postMessage({ type: 'stats', count: batchSize });
            count = 0;
        }
    }
}
