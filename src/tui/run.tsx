import { render } from "ink";
import type { BrightspaceApi } from "../brightspace.js";
import type { AppConfig } from "../types.js";
import { loadCatalog, loadCourseStatuses } from "./catalog.js";
import { TuiApp } from "./app.js";
import { loadTuiProfile } from "./profile.js";

export async function runTui(client: BrightspaceApi, config: AppConfig): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The TUI requires an interactive terminal.");
  }
  console.log("Loading courses and file status…");
  const [catalog, profile] = await Promise.all([
    loadCatalog(client, config.concurrency),
    loadTuiProfile(),
  ]);
  const courses = await Promise.all(catalog.courses.map(async (course) => {
    const outputDir = profile.courseDestinations[String(course.course.id)] || config.outputDir;
    return {
      catalog: course,
      outputDir,
      statuses: await loadCourseStatuses(course, outputDir),
    };
  }));

  const instance = render(
    <TuiApp
      client={client}
      config={config}
      leVersion={catalog.versions.le}
      initialCourses={courses}
      initialProfile={profile}
    />,
    { exitOnCtrlC: false, alternateScreen: true },
  );
  await instance.waitUntilExit();
}
