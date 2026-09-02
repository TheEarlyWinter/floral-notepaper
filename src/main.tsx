import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { getConfig } from "./features/settings/api";
import { getInitialRoute } from "./features/windows/windowRoutes";
import i18n, { initializeI18n } from "./locales";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element");
}

const mountTarget = rootElement;
const initialRoute = getInitialRoute();

async function bootstrap() {
  let locale: string | undefined;

  try {
    const config = await getConfig();
    locale = config.locale;
  } catch {
    locale = undefined;
  }

  await initializeI18n(locale);

  if (initialRoute.view === "pdf-export" && initialRoute.jobId) {
    const { PdfExportWindow } = await import("./features/importExport/PdfExportWindow");
    ReactDOM.createRoot(mountTarget).render(
      <I18nextProvider i18n={i18n}>
        <PdfExportWindow jobId={initialRoute.jobId} />
      </I18nextProvider>,
    );
    return;
  }

  const { default: App } = await import("./App");
  ReactDOM.createRoot(mountTarget).render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </React.StrictMode>,
  );
}

void bootstrap();
