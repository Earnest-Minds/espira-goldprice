import { useEffect, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  InlineStack,
  ResourceList,
  ResourceItem,
  TextField,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// 1) LOADER: Fetch up to 2000 active products using pagination
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  if (
    request.method === "GET" &&
    new URL(request.url).searchParams.get("action") === "getProducts"
  ) {
    let products = [];
    let cursor = null;
    const maxProducts = 2000;

    do {
      const response = await admin.graphql(
        `#graphql
          query ($cursor: String) {
            products(first: 250, after: $cursor, query: "status:ACTIVE") {
              edges {
                node {
                  id
                  title
                  status
                  handle
                  metafields(first: 15) {
                    edges {
                      node {
                        namespace
                        key
                        value
                      }
                    }
                  }
                  variants(first: 36) {
                    edges {
                      node {
                        id
                        title
                        price
                        compareAtPrice
                        metafields(first: 2) {
                          edges {
                            node {
                              namespace
                              key
                              value
                            }
                          }
                        }
                      }
                    }
                  }
                }
                cursor
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        {
          variables: { cursor },
        }
      );

      const responseJson = await response.json();
      const { edges, pageInfo } = responseJson.data.products;
      products = products.concat(edges.map((edge) => edge.node));
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor && products.length < maxProducts);

    return {
      products: products.slice(0, maxProducts),
    };
  }
  return null;
};

// 2) HELPER FUNCTIONS
const getMetafieldValue = (metafields, key) => {
  if (!metafields || !Array.isArray(metafields)) return null;
  const metafield = metafields.find(
    (m) => m.node.key === key && m.node.namespace === "custom"
  );
  return metafield ? metafield.node.value : null;
};

const getNumericMetafieldValue = (metafields, key) => {
  const val = getMetafieldValue(metafields, key);
  if (!val) return 0;
  const trimmed = val.trim();
  try {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.value !== undefined) {
        return parseFloat(parsed.value) || 0;
      }
    }
  } catch (e) {
    // If parsing fails, fallback to parseFloat
  }
  return parseFloat(val) || 0;
};

/**
 * Helper to process an array in chunks, running each chunk in parallel,
 * but waiting for one chunk to finish before starting the next.
 * @param {Array} array The items to process
 * @param {number} chunkSize How many items to process in parallel
 * @param {Function} callback An async function that takes an item and returns a promise
 */
async function processInChunks(array, chunkSize, callback) {
  let results = [];

  for (let i = 0; i < array.length; i += chunkSize) {
    const chunk = array.slice(i, i + chunkSize);

    // Process this chunk in parallel
    const chunkResults = await Promise.all(
      chunk.map((item) => callback(item))
    );

    // Collect results
    results = results.concat(chunkResults.filter(Boolean));
  }

  return results;
}

// 3) ACTION: Update product prices & metafields in chunks to avoid throttling
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  // Parse the gold price and making charges
  let price = parseFloat(formData.get("price"));
  const makingCharges = parseFloat(formData.get("makingCharges")) || 0;
  if (isNaN(price) || price <= 0) {
    return {
      success: false,
      message: "Invalid gold price provided.",
      debugLogs: ["Invalid gold price."],
    };
  }

  const productData = JSON.parse(formData.get("productData"));
  const diamondPrices = JSON.parse(formData.get("diamondPrices"));

  // We'll collect debug logs and return them for display
  const debugLogs = [];

  // Multipliers for gold karat
  const priceMap = {
    "24k": 1,
    "22k": 0.925,
    "18k": 0.76,
    "14k": 0.6,
    "9k": 0.385,
  };

  // Discount factors for diamond portion only
  const discountMap = {
    "10%": 0.9,
    "12%": 0.88,
    "15%": 0.85,
  };

  // Only allow these three colors
  const allowedColors = ["yellow gold", "rose gold", "white gold"];

  try {
    // Process products in chunks of 5 (you can adjust chunkSize to reduce/increase concurrency)
    const chunkSize = 5;

    const results = await processInChunks(productData, chunkSize, async (product) => {
      const metafields = product.metafields.edges;

      // Retrieve diamond types and weights from product metafields
      let diamondType_1 = getMetafieldValue(metafields, "diamond_1");
      let diamondType_2 = getMetafieldValue(metafields, "diamond_2");
      let diamondType_3 = getMetafieldValue(metafields, "diamond_3");
      if (typeof diamondType_1 === "string") diamondType_1 = diamondType_1.trim();
      if (typeof diamondType_2 === "string") diamondType_2 = diamondType_2.trim();
      if (typeof diamondType_3 === "string") diamondType_3 = diamondType_3.trim();

      const diamondWeight_1 = getNumericMetafieldValue(metafields, "diamond_weight_1");
      const diamondWeight_2 = getNumericMetafieldValue(metafields, "diamond_weight_2");
      const diamondWeight_3 = getNumericMetafieldValue(metafields, "diamond_weight_3");

      const selectedDiamonds = [
        { type: diamondType_1, weight: diamondWeight_1 },
        { type: diamondType_2, weight: diamondWeight_2 },
        { type: diamondType_3, weight: diamondWeight_3 },
      ].filter((item) => item.type);

      // Compute total diamond price
      let totalDiamondPrice = 0;
      if (selectedDiamonds.length > 0) {
        totalDiamondPrice = selectedDiamonds.reduce((sum, diamond) => {
          const typeNormalized = (diamond.type || "").trim();
          const perUnit = diamondPrices[typeNormalized] || 0;
          return sum + perUnit * diamond.weight;
        }, 0);
      }
      debugLogs.push(`Product: ${product.title} — totalDiamondPrice: ${totalDiamondPrice}`);

      // Process variants
      const variants = product.variants.edges
        .filter((edge) => {
          const titleLower = edge.node.title.toLowerCase();
          return allowedColors.some((color) => titleLower.includes(color));
        })
        .filter((edge) =>
          Object.keys(priceMap).some((k) => edge.node.title.toLowerCase().includes(k))
        )
        .map((edge) => {
          let variantLog = `Variant: "${edge.node.title}"`;

          // Identify the karat from the variant title
          const karatKey = Object.keys(priceMap).find((k) =>
            edge.node.title.toLowerCase().includes(k)
          );

          // Retrieve the variant's "gold weight" from its metafields
          const variantMetafields = edge.node.metafields.edges;
          const weight = getNumericMetafieldValue(variantMetafields, "weight");
          if (!weight) {
            variantLog += " | Warning: weight is missing or zero";
          } else {
            variantLog += ` | Weight: ${weight}`;
          }

          const makingChargesForWeight = weight > 0 ? makingCharges * weight : 0;
          const goldAndMakingCost =
            price * (priceMap[karatKey] || 0) * weight + makingChargesForWeight;

          // Calculate the compare-at price (before discount)
          let compareAtPrice = goldAndMakingCost + totalDiamondPrice;

          // Begin with full diamond cost
          let discountedDiamondCost = totalDiamondPrice;
          // Use regex to detect discount in the variant title
          const discountRegex = /(\d+)\s*%/i;
          const discountMatch = edge.node.title.match(discountRegex);
          if (discountMatch) {
            const discountFound = discountMatch[0].replace(/\s+/g, "");
            const discountFactor = discountMap[discountFound];
            if (discountFactor) {
              variantLog += ` | Match discount: "${discountFound}" => factor ${discountFactor}`;
              discountedDiamondCost = totalDiamondPrice * discountFactor;
            }
          }

          const updatedPrice = goldAndMakingCost + discountedDiamondCost;
          variantLog += ` | Gold+Making: ${goldAndMakingCost.toFixed(2)} | Diamond: ${discountedDiamondCost.toFixed(2)} | Final: ${updatedPrice.toFixed(2)} | CompareAtPrice: ${compareAtPrice.toFixed(2)}`;
          debugLogs.push(variantLog);

          return {
            id: edge.node.id,
            price: String(updatedPrice.toFixed(2)),
            compareAtPrice: String(compareAtPrice.toFixed(2)),
          };
        });

      if (variants.length === 0) {
        debugLogs.push(`No recognized variants for product "${product.title}".`);
        return null;
      }

      // Update product variants
      const response = await admin.graphql(
        `#graphql
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              product {
                id
              }
              productVariants {
                id
                price
                compareAtPrice
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            productId: product.id,
            variants: variants,
          },
        }
      );

      // Update the product metafield "custom.diamond_price"
      const metafieldResponse = await admin.graphql(
        `#graphql
          mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
                key
                value
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            metafields: [
              {
                ownerId: product.id,
                namespace: "custom",
                key: "diamond_price",
                value: totalDiamondPrice.toFixed(2),
                type: "number_decimal",
              },
            ],
          },
        }
      );
      const metafieldResult = await metafieldResponse.json();
      if (
        metafieldResult.data.metafieldsSet.userErrors &&
        metafieldResult.data.metafieldsSet.userErrors.length > 0
      ) {
        debugLogs.push(
          `Error updating metafield diamond_price for product "${product.title}": ${metafieldResult.data.metafieldsSet.userErrors
            .map((e) => e.message)
            .join(", ")}`
        );
      }

      return response.json();
    });

    // Collect userErrors from all chunk updates
    const errors = results
      .flatMap((result) => (result ? result.data.productVariantsBulkUpdate.userErrors : []))
      .filter((error) => error);

    if (errors.length > 0) {
      return {
        success: false,
        message: `Error updating prices: ${errors.map((e) => e.message).join(", ")}`,
        debugLogs,
      };
    }

    return { success: true, message: "Product prices updated successfully", debugLogs };
  } catch (error) {
    const errorMsg = `Update error: ${error.message}`;
    debugLogs.push(errorMsg);
    return { success: false, message: error.message, debugLogs };
  }
};

// 4) REACT COMPONENT: Show Banner on success/error instead of using alert()
export default function Index() {
  const fetcher = useFetcher();

  // Gold price & loading/error states
  const [goldPrice, setGoldPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Product data & loading states
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);

  // Input fields
  const [priceInput, setPriceInput] = useState("10500");
  const [makingChargesInput, setMakingChargesInput] = useState("1500");
  const [diamondPrices, setDiamondPrices] = useState({
    "Round Solitaire 5ct+": 30000,
    "Round Solitaire 3ct+": 30000,
    "Round Solitaire 2ct+": 30000,
    "Round Solitaire 0.50ct+": 30000,
    "Fancy Solitaire 5ct+": 30000,
    "Fancy Solitaire 3ct+": 30000,
    "Fancy Solitaire 2ct+": 30000,
    "Fancy Solitaire 0.5ct+": 30000,
    "Small Diamonds": 20000,
    "Gemstones": 15000,
  });

  // Debug logs
  const [debugLogs, setDebugLogs] = useState([]);

  // NEW: Banner message & status
  const [bannerMessage, setBannerMessage] = useState("");
  const [bannerStatus, setBannerStatus] = useState("info"); // "success", "critical", etc.

  // Fetch gold price
  const fetchGoldPrice = async () => {
    setLoading(true);
    setError(null);
    try {
      const apiKey = "goldapi-43irpsm4wlppn5-io"; // Replace with your actual API key
      const response = await fetch("https://www.goldapi.io/api/XAU/INR", {
        headers: {
          "x-access-token": apiKey,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        throw new Error("Failed to fetch gold price");
      }
      const data = await response.json();
      // Adjust the 24K price by a factor if needed
      setGoldPrice(data.price_gram_24k + 0.05 * data.price_gram_24k);
    } catch (err) {
      setError(err.message);
      console.error("Error fetching gold price:", err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch products
  const fetchProducts = () => {
    setProductsLoading(true);
    try {
      fetcher.submit({ action: "getProducts" }, { method: "GET" });
    } catch (err) {
      console.error("Error fetching products:", err);
    } finally {
      setProductsLoading(false);
    }
  };

  // On mount, fetch gold price and products
  useEffect(() => {
    fetchGoldPrice();
    fetchProducts();
    // Refresh gold price every 5 minutes
    const interval = setInterval(fetchGoldPrice, 300000);
    return () => clearInterval(interval);
  }, []);

  // Listen for fetcher data changes
  useEffect(() => {
    if (fetcher.data?.products) {
      // Loader data from GET
      setProducts(fetcher.data.products);
    } else if (fetcher.data?.message) {
      // Action response from POST
      setBannerMessage(fetcher.data.message);
      setBannerStatus(fetcher.data.success ? "success" : "critical");

      if (fetcher.data.debugLogs) {
        setDebugLogs(fetcher.data.debugLogs);
      }
      if (fetcher.data.success) {
        // If update succeeded, re-fetch products to show new prices
        fetchProducts();
      }
    }
  }, [fetcher.data]);

  // Handlers for input changes
  const handlePriceChange = (value) => setPriceInput(value);
  const handleMakingChargesChange = (value) => setMakingChargesInput(value);
  const handleDiamondPriceChange = (type, value) => {
    setDiamondPrices((prevPrices) => ({
      ...prevPrices,
      [type]: parseFloat(value) || 0,
    }));
  };

  // Button to start update
  const handleButtonClick = async () => {
    if (!priceInput || isNaN(priceInput) || parseFloat(priceInput) <= 0) {
      setBannerMessage("Please enter a valid gold price");
      setBannerStatus("critical");
      return;
    }
    setLoading(true);
    try {
      fetcher.submit(
        {
          price: priceInput,
          makingCharges: makingChargesInput,
          diamondPrices: JSON.stringify(diamondPrices),
          productData: JSON.stringify(products),
        },
        { method: "POST" }
      );
    } catch (err) {
      setBannerMessage("Error updating prices");
      setBannerStatus("critical");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page>
      <TitleBar title="Update Prices" />

      <Layout>
        {/* SECTION: Banner for success/error messages */}
        <Layout.Section>
          {bannerMessage && (
            <Card sectioned>
              <Banner
                title={bannerStatus === "success" ? "Success" : "Error"}
                status={bannerStatus}
              >
                <p>{bannerMessage}</p>
              </Banner>
            </Card>
          )}
        </Layout.Section>

        {/* SECTION: Gold price & update controls */}
        <Layout.Section variant="oneHalf">
          <Card padding="1600">
            <BlockStack gap="400">
              <Text variant="headingLg" alignment="center">
                Current Gold Price (24K)
              </Text>
              {loading && <Text alignment="center">Loading gold price...</Text>}
              {error && (
                <Text alignment="center" color="critical">
                  Error: {error}
                </Text>
              )}
              {goldPrice && !loading && !error && (
                <BlockStack gap="200">
                  <Text variant="heading2xl" alignment="center">
                    ₹
                    {goldPrice.toLocaleString("en-IN", {
                      maximumFractionDigits: 2,
                      minimumFractionDigits: 2,
                    })}
                  </Text>
                  <Text variant="bodySm" alignment="center">
                    per gram
                  </Text>
                </BlockStack>
              )}
              <InlineStack gap="300" align="center">
                <Button onClick={fetchGoldPrice} loading={loading} disabled={loading}>
                  Refresh Price
                </Button>
              </InlineStack>
              <BlockStack gap="400" alignment="center">
                <InlineStack gap="300" align="center">
                  <TextField
                    label="Gold Price 24k (₹)"
                    value={priceInput}
                    onChange={handlePriceChange}
                    autoComplete="off"
                    type="number"
                  />
                  <TextField
                    label="Making Charges (₹)"
                    value={makingChargesInput}
                    onChange={handleMakingChargesChange}
                    autoComplete="off"
                    type="number"
                  />
                </InlineStack>
              </BlockStack>
              <BlockStack gap="400">
                <Text variant="headingMd">Diamond Prices (₹)</Text>
                {Object.entries(diamondPrices).map(([type, value]) => (
                  <TextField
                    key={type}
                    label={type}
                    value={value}
                    onChange={(val) => handleDiamondPriceChange(type, val)}
                    type="number"
                  />
                ))}
              </BlockStack>
              <InlineStack gap="300" align="center">
                <Button onClick={handleButtonClick} loading={loading} variant="primary">
                  Update Prices
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* SECTION: Product List */}
        <Layout.Section>
          <Card>
            <BlockStack gap="4">
              <Text variant="headingLg">Available Products</Text>
              {productsLoading ? (
                <Text alignment="center">Loading products...</Text>
              ) : (
                <ResourceList
                  items={products}
                  renderItem={(product) => (
                    <ResourceItem
                      id={product.id}
                      accessibilityLabel={`View details for ${product.title}`}
                    >
                      <BlockStack gap="200">
                        <Text variant="h6" fontWeight="bold">
                          {product.title}
                        </Text>
                        {product.metafields.edges
                          .filter((mEdge) => mEdge.node.namespace === "custom")
                          .map((mEdge, index) => (
                            <Text key={index} variant="bodySm" color="subdued">
                              {mEdge.node.key}: {mEdge.node.value}
                            </Text>
                          ))}
                        {product.variants.edges.map((edge, idx) => (
                          <BlockStack key={idx} gap="1">
                            <Text variant="bodyMd" fontWeight="bold">
                              Variant: {edge.node.title || "No Title"}
                            </Text>
                            <Text variant="bodySm">
                              Price: ₹{edge.node.price || "N/A"}
                            </Text>
                            <Text variant="bodySm">
                              Compare At Price: ₹{edge.node.compareAtPrice || "N/A"}
                            </Text>
                            <Text variant="bodySm">
                              Weight:{" "}
                              {getMetafieldValue(edge.node.metafields.edges, "weight")
                                ? `${getMetafieldValue(edge.node.metafields.edges, "weight")} g`
                                : "N/A"}
                            </Text>
                          </BlockStack>
                        ))}
                      </BlockStack>
                    </ResourceItem>
                  )}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>
    </Page>
  );
}
