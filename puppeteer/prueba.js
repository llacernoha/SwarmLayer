import puppeteer from 'puppeteer';

// Configuración fija y clara
const APP_URL        = 'https://dashp2p.infinitebuffer.com/';
const NUM_PEERS      = 5;      // cuántos peers abrir
const START_DELAY_MS = 3000;   // pausa entre peers (ms)
const RUN_SECONDS    = 800;    // cuánto tiempo mantenerlos abiertos (s)

// Lanza un navegador, abre una pestaña y carga la APP_URL
async function launchPeer() {
  // Abrir navegador
  const browser = await puppeteer.launch({
    headless: 'new',
  });

  const page = await browser.newPage();

  // Navegar a la app
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

  // Intentar mutear el vídeo
  await page.evaluate(() => {
    const video = document.getElementById('video');
    if (!video) return;
    video.muted = true;
  });

  // devolvemos el navegador para poder cerrarlo después
  return browser;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  const browsers = [];

  // Lanzamos los peers uno a uno con una pequeña pausa entre ellos
  for (let i = 0; i < NUM_PEERS; i++) {
    if (i > 0) {
      await wait(START_DELAY_MS);
    }

    const browser = await launchPeer();
    browsers.push(browser);
  }

  await wait(RUN_SECONDS * 1000);

  // Cerramos todos los navegadores
  for (const browser of browsers) {
    try {
      await browser.close();
    } catch (e) {
      //
    }
  }

  process.exit(0);
})();
