import { Suspense } from "react";

import H5UploadClient from "@/app/h5/H5UploadClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function H5Page() {
  return (
    <Suspense fallback={null}>
      <H5UploadClient />
    </Suspense>
  );
}
