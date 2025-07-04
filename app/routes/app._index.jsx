// app/routes/index.jsx

import React, { useEffect, useMemo, useRef, useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Banner,
  BlockStack,
  TextField,
  ResourceList,
  ResourceItem,
  Button,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// 1) Fetch products with optionValues
const PRODUCTS_QUERY = `#graphql
  query AllProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          title
          options {
            id
            name
            position
            optionValues {
              id
              name
            }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

// 2a) Remove extra option values (will delete associated variants) :contentReference[oaicite:0]{index=0}
const UPDATE_OPTION_MUTATION = `#graphql
  mutation updateOptionValues(
    $productId: ID!,
    $option: OptionUpdateInput!,
    $optionValuesToDelete: [ID!]!
  ) {
    productOptionUpdate(
      productId: $productId,
      option: $option,
      optionValuesToDelete: $optionValuesToDelete,
      variantStrategy: MANAGE
    ) {
      userErrors { field message code }
    }
  }
`;

// 2b) Delete the now–single-value option 
const DELETE_OPTION_MUTATION = `#graphql
  mutation deleteOptions($productId: ID!, $options: [ID!]!) {
    productOptionsDelete(productId: $productId, options: $options) {
      deletedOptionsIds
      userErrors { field message code }
    }
  }
`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  let allProducts = [];
  let hasNextPage = true;
  let afterCursor = null;

  while (hasNextPage) {
    const res = await admin.graphql(PRODUCTS_QUERY, {
      variables: { first: 250, after: afterCursor },
    });
    const { data } = await res.json();
    const { edges, pageInfo } = data.products;
    edges.forEach(({ node }) => allProducts.push(node));
    hasNextPage = pageInfo.hasNextPage;
    afterCursor = hasNextPage ? edges[edges.length - 1].cursor : null;
  }

  return json({ products: allProducts });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const optionName = form.get("optionName")?.toString().trim() || "";

  console.log("🗑️ Deleting option:", optionName);
  if (!optionName) {
    return json({ success: false, error: "Please enter an option name." });
  }

  // re-fetch products
  let allProducts = [];
  let hasNextPage = true;
  let afterCursor = null;
  while (hasNextPage) {
    const res = await admin.graphql(PRODUCTS_QUERY, {
      variables: { first: 250, after: afterCursor },
    });
    const { data } = await res.json();
    const { edges, pageInfo } = data.products;
    edges.forEach(({ node }) => allProducts.push(node));
    hasNextPage = pageInfo.hasNextPage;
    afterCursor = hasNextPage ? edges[edges.length - 1].cursor : null;
  }

  const errors = [];
  for (const prod of allProducts) {
    const opt = prod.options.find(o =>
      o.name.toLowerCase().includes(optionName.toLowerCase())
    );
    if (!opt) continue;

    // if multiple values, delete all but the first
    if (opt.optionValues.length > 1) {
      const toDelete = opt.optionValues.map(v => v.id).slice(1);
      console.log(`→ Removing extra values from "${prod.title}":`, toDelete);
      const upd = await admin.graphql(UPDATE_OPTION_MUTATION, {
        variables: {
          productId: prod.id,
          option: {
            id: opt.id,
            name: opt.name,
            position: opt.position,
          },
          optionValuesToDelete: toDelete,
        },
      });
      const updRes = await upd.json();
      const ue = updRes.data.productOptionUpdate.userErrors;
      if (ue.length) {
        console.error(`Error updating "${prod.title}":`, ue);
        errors.push(...ue.map(e => e.message));
        continue;
      }
    }

    // now delete the single-value option
    console.log(`→ Deleting option from "${prod.title}":`, opt.id);
    const del = await admin.graphql(DELETE_OPTION_MUTATION, {
      variables: { productId: prod.id, options: [opt.id] },
    });
    const delRes = await del.json();
    const de = delRes.data.productOptionsDelete;
    if (de.userErrors.length) {
      console.error(`Error deleting from "${prod.title}":`, de.userErrors);
      errors.push(...de.userErrors.map(e => e.message));
    } else {
      console.log(`✔️ Deleted option "${opt.name}" from "${prod.title}"`);
    }
  }

  if (errors.length) {
    return json({ success: false, error: errors.join("; ") });
  }
  return json({ success: true });
};

export default function Index() {
  const { products } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [localProducts, setLocalProducts] = useState(products);
  const [searchTerm, setSearchTerm] = useState("");
  const lastTerm = useRef("");

  const filtered = useMemo(() => {
    if (!searchTerm.trim()) return localProducts;
    return localProducts.filter(p =>
      p.options.some(o =>
        o.name.toLowerCase().includes(searchTerm.toLowerCase())
      )
    );
  }, [localProducts, searchTerm]);

  useEffect(() => {
    shopify.toast.show(`Fetched ${localProducts.length} products`);
  }, [shopify, localProducts.length]);

  useEffect(() => {
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { error: true });
    } else if (fetcher.data?.success) {
      const term = lastTerm.current;
      const count = filtered.length;
      // remove the option from local state
      setLocalProducts(prev =>
        prev.map(p => ({
          ...p,
          options: p.options.filter(o =>
            !o.name.toLowerCase().includes(term.toLowerCase())
          ),
        }))
      );
      shopify.toast.show(
        `Removed “${term}” from ${count} product${count !== 1 ? "s" : ""}`
      );
      setSearchTerm("");
    }
  }, [fetcher.data, filtered.length, shopify]);

  return (
    <Page>
      <TitleBar title="All Products" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <TextField
                label="Search by option name"
                placeholder="e.g. Pack weight"
                value={searchTerm}
                onChange={setSearchTerm}
                clearButton
                onClearButtonClick={() => setSearchTerm("")}
              />
              <Banner status="info">
                <Text as="p" variant="bodyMd">
                  {searchTerm.trim()
                    ? `${filtered.length} product${filtered.length !== 1 ? "s" : ""} match “${searchTerm}”`
                    : `Total Products: ${localProducts.length}`}
                </Text>
              </Banner>
              <Button
                destructive
                onClick={() => {
                  const term = searchTerm.trim();
                  if (!term) {
                    shopify.toast.show("Enter an option name first", { error: true });
                    return;
                  }
                  lastTerm.current = term;
                  fetcher.submit({ optionName: term }, { method: "post" });
                }}
                loading={fetcher.state === "submitting"}
                disabled={fetcher.state === "submitting"}
              >
                Remove “{searchTerm}” from {filtered.length} products
              </Button>
              <ResourceList
                resourceName={{ singular: "product", plural: "products" }}
                items={filtered.map(p => ({
                  id: p.id,
                  title: p.title,
                  options: p.options,
                }))}
                renderItem={({ id, title, options }) => (
                  <ResourceItem id={id} accessibilityLabel={`View details for ${title}`}>
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingMd">{title}</Text>
                      {options.map(opt => (
                        <Text as="p" variant="bodySm" key={opt.id}>
                          {opt.name}: {opt.optionValues.map(v => v.name).join(", ")}
                        </Text>
                      ))}
                    </BlockStack>
                  </ResourceItem>
                )}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
