-- Disposable local/CI fixture proving the forward migration removes policy
-- drift without relying on policy names, predicates, roles, or bucket text.

CREATE POLICY "pintpath drift ""quoted"" object policy"
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "pintpath unrelated bucket predicate"
  ON storage.objects
  FOR SELECT
  TO anon
  USING (bucket_id = 'unrelated-public-assets');

CREATE POLICY "pintpath broad bucket mutation"
  ON storage.buckets
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
