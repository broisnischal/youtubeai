import { json } from "@remix-run/react";

import { useState } from "react";
import { ClientOnly } from "remix-utils/client-only";

import MyDropzone from "~/components/VideoUploader";

export async function loader() {
  // let pipe = await pipeline("text-generation");

  return json({});
}

export default function Index() {
  return (
    <ClientOnly fallback={<div>Loading...</div>}>
      {() => (
        <div className=" m-auto p-12">
          <h1 className="text-3xl font-bold mb-6 text-center">
            YouTube Title, Description, Thumbnail Generator
          </h1>
          <MyDropzone />
        </div>
      )}
    </ClientOnly>
  );
}
