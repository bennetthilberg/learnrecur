ALTER TABLE "material_pages"
  ADD CONSTRAINT "material_pages_pageNumber_check" CHECK ("pageNumber" > 0),
  ADD CONSTRAINT "material_pages_tokenEstimate_check" CHECK ("tokenEstimate" >= 0);
