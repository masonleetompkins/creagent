import { redirect } from "next/navigation";
import { createProject, listProjects } from "@/lib/video";

export const dynamic = "force-dynamic";

export default function VideosPage(): never {
  const projects = listProjects();
  if (projects.length === 0) {
    redirect(`/videos/${createProject({}).id}`);
  }
  redirect(`/videos/${projects[0].id}`);
}
