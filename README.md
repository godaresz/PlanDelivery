# Shipping Check WH1 / WH4 — วิธีติดตั้ง

Web App ดูสถานะการส่งของ WH1 และ WH4 พร้อมกัน ข้อมูลเก็บใน Firebase Firestore ทุกคนที่เปิดลิงก์จะเห็นข้อมูลชุดเดียวกัน และหน้าจออัปเดตเองเมื่อมีคนอัปโหลดไฟล์ใหม่

## โครงสร้าง

- หน้าเว็บ deploy บน **Netlify** เชื่อมกับ GitHub repo นี้ ทุกครั้งที่ push เข้า `main` Netlify จะ deploy ใหม่เอง (ไม่มีขั้นตอน build)
- ข้อมูลเก็บใน **Firebase Firestore** แพ็กเกจ Spark (ฟรี ไม่ต้องผูกบัตร ใช้เกินโควต้าแล้วหยุดชั่วคราว ไม่โดนเก็บเงิน)
  - Firestore ฟรี: อ่าน 50,000 ครั้ง/วัน, เขียน 20,000 ครั้ง/วัน, เก็บ 1 GiB
  - แอปนี้เปิดหน้าเว็บ 1 ครั้งอ่านประมาณ 10 ครั้ง อัปโหลดไฟล์ 1 ครั้งเขียนประมาณ 3 ครั้ง

## ตั้งค่าครั้งแรก

### 1. Firebase (เก็บข้อมูล + login)
1. console.firebase.google.com → สร้างโปรเจกต์ (แพ็กเกจ Spark)
2. **Firestore Database** → Create database → Production mode → region `asia-southeast1`
3. Firestore → แท็บ **Rules** → วางเนื้อหาจากไฟล์ `firestore.rules` → Publish
4. **Authentication** → Sign-in method → เปิด Email/Password → แท็บ Users → Add user (บัญชีสำหรับคนอัปโหลดไฟล์)
5. Project settings → Your apps → เพิ่ม **Web app** → คัดลอกค่า `firebaseConfig` มาวางในไฟล์ `firebase-config.js` แล้ว commit + push
   (ค่า config ของ Firebase เว็บไม่ใช่ความลับ การป้องกันข้อมูลอยู่ที่ Firestore Rules)

### 2. Netlify (หน้าเว็บ)
1. app.netlify.com → **Add new site → Import an existing project → GitHub** → เลือก repo นี้
2. Branch: `main`, Build command: เว้นว่าง, Publish directory: `.` (ค่าใน `netlify.toml` ใส่ไว้ให้แล้ว)
3. Deploy → ได้ลิงก์ `https://<ชื่อ>.netlify.app`
4. กลับไปที่ Firebase → Authentication → Settings → **Authorized domains** → เพิ่มโดเมน `<ชื่อ>.netlify.app` (ไม่อย่างนั้น login ไม่ได้)

### 3. ใช้งาน
เปิดลิงก์ Netlify → กด "เข้าสู่ระบบ" → อัปโหลด DataSlide, WMS WH1, WMS WH4

ถ้า `apiKey` ใน `firebase-config.js` ว่าง แอปจะทำงานใน **โหมดทดลอง** เก็บข้อมูลในเบราว์เซอร์เครื่องนั้นเท่านั้น

> ไฟล์ `firebase.json` / `.firebaserc` ใช้เฉพาะกรณีอยากย้ายไป deploy บน Firebase Hosting ด้วย `firebase deploy` แทน Netlify

## กติกาที่ใช้คำนวณ

- **Due ที่ใช้**
  1. Order อยู่ใน DataSlide และ New Due Date/Time เป็นวันที่และเวลา → ใช้วันเวลาใหม่ (ช่วงเวลา เช่น `7:30 - 8:30` ใช้เวลาท้ายช่วง)
  2. Order อยู่ใน DataSlide แต่ช่องเป็นข้อความอื่น (on time, on due, not change, ว่าง) → ใช้ Due ใน WMS
  3. Order ไม่อยู่ใน DataSlide → ใช้กฎ Slide Due ตาม Dock ถ้า Dock และเวลาตรงกฎ ไม่ตรงก็ใช้ Due ใน WMS
- **ส่งแล้ว** = Shipping Confirm เป็น CONFIRMED หรือมี Shipping Time และ Truck License ขาออก (คอลัมน์ Truck License ตัวที่ 2) ที่ไม่ว่างและไม่ใช่ 0
- **ยิงแล้ว ยังไม่ขึ้นรถ** = มี Shipping Time แต่ยังไม่มีทะเบียนรถ นับเป็นยังไม่ส่ง
- **Pallet / Rack** = นับเลข Pallet No. ไม่ซ้ำ ถ้า RFID เป็น 0 ทั้งหมดนับเป็น Rack
- **อัปโหลด DataSlide** = ล้างข้อมูลเดิมแล้วใช้ไฟล์ใหม่ทั้งหมด
- **อัปโหลดไฟล์ WMS** = ใช้ข้อมูลใหม่แทนของเดิม แต่รายการที่ส่งแล้ว (Complete) ในรอบก่อนจะเก็บไว้แสดงเป็น "ส่งแล้ว" ต่อ จนเกินจำนวนวันที่ตั้งไว้ในหน้ากฎ (ค่าเริ่มต้น 7 วัน)
