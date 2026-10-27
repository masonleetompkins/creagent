import { redirect } from "next/navigation";
import { createProject, listProjects } from "@/lib/carousel";

export const dynamic = "force-dynamic";

export default function CarouselsPage(): never {
  const projects = listProjects();
  if (projects.length === 0) {
    redirect(`/carousels/${createProject({}).id}`);
  }
  redirect(`/carousels/${projects[0].id}`);
}
