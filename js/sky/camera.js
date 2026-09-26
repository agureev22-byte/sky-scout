// Видео с задней камеры для режима AR. Кадры никуда не отправляются — только на экран.

let stream = null;
// Каждый stopCamera() увеличивает поколение: запуск камеры, начатый раньше, узнаёт,
// что его отменили (пользователь уже переключил режим), и сам гасит полученный поток.
let generation = 0;

function abortError() {
  const e = new Error('Запуск камеры отменён');
  e.name = 'AbortError';
  return e;
}

export function cameraSupported() {
  return typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

const ERRORS = {
  NotAllowedError: 'Доступ к камере запрещён. Разрешите камеру для этого сайта: «аА» в адресной строке Safari → «Настройки веб-сайта» → «Камера», — и снова выберите AR.',
  NotFoundError: 'Камера не найдена.',
  NotReadableError: 'Камера занята другим приложением.',
  OverconstrainedError: 'Камера не поддерживает нужный режим.',
  SecurityError: 'Камера доступна только по защищённому адресу (https).',
};

export async function startCamera(video) {
  if (!cameraSupported()) throw new Error('Этот браузер не умеет показывать камеру.');
  stopCamera(video);
  const gen = generation;
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    if (gen !== generation) throw abortError();
    throw new Error(ERRORS[err && err.name] || 'Не удалось включить камеру.');
  }
  if (gen !== generation) {
    s.getTracks().forEach((t) => t.stop());
    throw abortError();
  }
  stream = s;
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = s;
  try {
    await video.play();
  } catch {
    /* iOS иногда требует повторного play() после жеста — видео всё равно появится */
  }
  if (!video.videoWidth) {
    await new Promise((resolve) => {
      const done = () => resolve();
      video.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(done, 1500);
    });
  }
  if (gen !== generation) throw abortError();
  return s;
}

export function stopCamera(video) {
  generation++;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (video) video.srcObject = null;
}

// Фокусное расстояние в CSS-пикселях для видео, растянутого на экран с обрезкой (object-fit: cover).
// fovLongDeg — поле зрения камеры по длинной стороне кадра.
export function videoFocal(video, width, height, fovLongDeg) {
  const vw = video.videoWidth || 720;
  const vh = video.videoHeight || 1280;
  const scale = Math.max(width / vw, height / vh);
  const longPx = Math.max(vw, vh) * scale;
  return longPx / 2 / Math.tan(((fovLongDeg / 2) * Math.PI) / 180);
}
