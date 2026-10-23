import readline from "node:readline/promises";
import { makePkce, buildAuthUrl, parseRedirect, exchangeCode } from "./api/mes-auth.js";

const { verifier, challenge, state } = makePkce();

console.log("\n1) Откройте ссылку в браузере и войдите:\n");
console.log(buildAuthUrl({ challenge, state }));
console.log("\n2) После входа страница localhost не откроется, это нормально.");
console.log("   Скопируйте адрес целиком из адресной строки.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("3) Вставьте адрес сюда: ");
rl.close();

const { code, state: backState } = parseRedirect(answer);

if (backState !== state) {
  console.error("\nstate не совпал. Запускайте скрипт заново и входите по новой ссылке.");
  process.exit(1);
}

try {
  const t = await exchangeCode({ code, verifier });
  console.log("\nУспех. Сервер вернул поля:", Object.keys(t).join(", "));
  console.log("expires_in:", t.expires_in);
  console.log("refresh_token получен:", Boolean(t.refresh_token));
} catch (e) {
  console.error("\nОшибка:", e.message);
}
