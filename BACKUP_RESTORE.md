# BACKUP AND DISASTER RECOVERY PROCEDURES (Захиралаш ва тиклаш қўлланмаси)

Ушбу ҳужжат маълумотлар базаси (PostgreSQL) ва ҳимояланган файллар омбори (MinIO / S3) учун тўлиқ захиралаш ва тиклаш бўйича кўрсатмаларни ўз ичига олади.

---

## 1. Маълумотлар базасини захиралаш (PostgreSQL Backup)

### 1.1 Тўлиқ захира нусхасини олиш (Logical Dump)
Docker контейнер муҳитида:
```bash
docker exec -t hisobchi_postgres pg_dump -U hisobchi -d hisobchi_db -F c -b -v -f /backups/db_backup_$(date +%Y%m%d_%H%M%S).dump
```

Локал Windows муҳитида (PowerShell):
```powershell
$backupFile = "backup_$(Get-Date -Format 'yyyyMMdd_HHmmss').dump"
& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -U postgres -h localhost -p 5432 -F c -b -v -f $backupFile hisobchi_db
```

### 1.2 Автоматик даврий захира (Cron / Task Scheduler)
Ҳар кеча соат 02:00 да автоматик тарзда захиралаш ва 14 кундан эски нусхаларни тозалаш тавсия этилади.

---

## 2. Базани тиклаш (PostgreSQL Restore)

### 2.1 Тоза базага тиклаш
```bash
# Базани қайта яратиш
docker exec -i hisobchi_postgres psql -U hisobchi -c "DROP DATABASE IF EXISTS hisobchi_db;"
docker exec -i hisobchi_postgres psql -U hisobchi -c "CREATE DATABASE hisobchi_db;"

# Захира файлидан тиклаш
docker exec -i hisobchi_postgres pg_restore -U hisobchi -d hisobchi_db -v /backups/db_backup_XXXXXX.dump
```

Локал Windows муҳитида:
```powershell
& "C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" -U postgres -h localhost -p 5432 -d hisobchi_db -v $backupFile
```

---

## 3. Объектлар омборини захиралаш (S3 / MinIO Files)

Паспорт расмлари, шартнома скриншотлари ва видео эслатмалар MinIO/S3 private bucket’ида сақланади:

### 3.1 MinIO Client (mc) орқали синхронизация
```bash
# MinIO bucket’ни маҳаллий каталогга синхронлаш
mc mirror local/hisobchi-private /storage/backups/s3_$(date +%Y%m%d)
```

### 3.2 Файлларни тиклаш
```bash
mc mirror /storage/backups/s3_XXXXXX local/hisobchi-private
```

---

## 4. Ҳалокатдан сўнг тиклаш (Disaster Recovery Checklist)
1. Docker Compose муҳитини ишга тушириш: `docker compose up -d postgres redis minio`
2. Сўнгги PostgreSQL захира нусхасини `pg_restore` ёрдамида тиклаш.
3. Prisma миграцияларини текшириш: `npx prisma migrate deploy`
4. Файлларни MinIO bucket’га тиклаш.
5. `npm run start:prod` орқали асосий бот ва backend хизматини ишга тушириш.
6. `/health` ва `/health/ready` endpoint’ларини текшириш.
