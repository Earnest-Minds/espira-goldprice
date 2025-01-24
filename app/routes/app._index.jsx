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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  if (
    request.method === "GET" &&
    new URL(request.url).searchParams.get("action") === "getProducts"
  ) {
    const response = await admin.graphql(
      `#graphql
        query {
          products(first: 250, query: "status:ACTIVE") {
            edges {
              node {
                id
                title
                status
                handle
                metafields(first: 50) {
                  edges {
                    node {
                      namespace
                      key
                      value
                    }
                  }
                }
                variants(first: 5) {
                  edges {
                    node {
                      id
                      title
                      price
                      metafield(namespace: "custom", key: "weight") {
                        value
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `
    );

    const responseJson = await response.json();
    return {
      products: responseJson.data.products.edges.map((edge) => edge.node),
    };
  }

  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const price = parseFloat(formData.get("price"));
  const makingCharges = parseFloat(formData.get("makingCharges")) || 0;
  const discountPrice = parseFloat(formData.get("discountPrice")) || 0; // Get discount
  const productData = JSON.parse(formData.get("productData"));
  const diamondPrices = JSON.parse(formData.get("diamondPrices"));

  const priceMap = {
    "24k": 1,
    "22k": 0.925,
    "18k": 0.76,
    "14k": 0.6,
    "9k": 0.385,
  };

  const parseMetafieldValue = (value) => {
    if (!value) return null;
    try {
      if (value.startsWith("{") || value.startsWith("[")) {
        return JSON.parse(value);
      }
    } catch {
      console.warn("Invalid JSON in metafield:", value);
    }
    return value;
  };

  const getMetafieldValue = (metafields, key) => {
    const metafield = metafields.find(
      (m) => m.node.key === key && m.node.namespace === "custom"
    );
    return metafield ? parseMetafieldValue(metafield.node.value) : null;
  };

  try {
    const updatePromises = productData.map(async (product) => {
      const metafields = product.metafields.edges;

      const diamondType_1 = getMetafieldValue(metafields, "diamond_1");
      const diamondType_2 = getMetafieldValue(metafields, "diamond_2");
      const diamondType_3 = getMetafieldValue(metafields, "diamond_3");

      const diamondWeight_1 = getMetafieldValue(metafields, "diamond_weight_1")?.value || 0;
      const diamondWeight_2 = getMetafieldValue(metafields, "diamond_weight_2")?.value || 0;
      const diamondWeight_3 = getMetafieldValue(metafields, "diamond_weight_3")?.value || 0;

      const selectedDiamonds = [
        { type: diamondType_1, weight: diamondWeight_1 },
        { type: diamondType_2, weight: diamondWeight_2 },
        { type: diamondType_3, weight: diamondWeight_3 },
      ].filter((item) => item.type);

      const diamondPricesCalculated = selectedDiamonds.map((diamond) => ({
        type: diamond.type,
        price: (diamondPrices[diamond.type] || 0) * diamond.weight,
      }));

      let totalPrice = diamondPricesCalculated.reduce((sum, item) => sum + item.price, 0);

      // Apply discount to the total diamond price
      totalPrice = Math.max(totalPrice - discountPrice, 0); // Ensure the total doesn't go below 0

      const variants = product.variants.edges
        .filter((edge) =>
          Object.keys(priceMap).some((k) =>
            edge.node.title.toLowerCase().includes(k)
          )
        )
        .map((edge) => {
          const karat = Object.keys(priceMap).find((k) =>
            edge.node.title.toLowerCase().includes(k)
          );
          const weightMetafield = edge.node.metafield?.value;

          let weight = 0; // Default weight to 0 for invalid cases
          try {
            const parsedWeight = parseMetafieldValue(weightMetafield);
            weight =
              parsedWeight?.value && parsedWeight.unit === "GRAMS"
                ? parseFloat(parsedWeight.value)
                : 0;
          } catch {
            weight = weightMetafield === "N/A" ? 0 : parseFloat(weightMetafield) || 0;
          }

          // Apply making charges only if weight > 0
          const makingChargesForWeight = weight > 0 ? makingCharges * weight : 0;

          // Calculate final price (gold + diamond with discount)
          const updatedPrice =
            price * priceMap[karat] * weight + makingChargesForWeight + totalPrice;

          return {
            id: edge.node.id,
            price: String(updatedPrice.toFixed(2)),
          };
        });

      if (variants.length === 0) return null;

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

      return response.json();
    });

    const results = (await Promise.all(updatePromises)).filter(Boolean);
    const errors = results
      .flatMap((result) => result.data.productVariantsBulkUpdate.userErrors)
      .filter((error) => error);

    if (errors.length > 0) {
      return {
        success: false,
        message: `Error updating prices: ${errors.map((e) => e.message).join(", ")}`,
      };
    }

    return { success: true, message: "Product prices updated successfully" };
  } catch (error) {
    console.error("Update error:", error);
    return { success: false, message: error.message };
  }
};




export default function Index() {
  const fetcher = useFetcher();
  const [goldPrice, setGoldPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [priceInput, setPriceInput] = useState("8000");
  const [makingChargesInput, setMakingChargesInput] = useState("1200");
  const [discountPriceInput, setDiscountPriceInput] = useState("0"); // New discount state

  const [diamondPrices, setDiamondPrices] = useState({
    "Round Solitaire 5ct+": 30000,
    "Round Solitaire 3ct+": 30000,
    "Round Solitaire 2ct+": 30000,
    "Round Solitaire 0.50ct+": 30000,
    "Fancy Solitaire 5ct+": 30000,
    "Fancy Solitaire 3ct+": 30000,
    "Fancy Solitaire 2ct+": 30000,
    "Fancy Solitaire 0.5ct+": 30000,
    "Small Diamonds": 15000,
    "Gemstones": 15000,
  });

  const fetchGoldPrice = async () => {
    setLoading(true);
    setError(null);
    try {
      const apiKey = "goldapi-b96usm5mg976t-io";
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
      setGoldPrice(data.price_gram_24k);
    } catch (error) {
      setError(error.message);
      console.error("Error fetching gold price:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = () => {
    setProductsLoading(true);
    try {
      fetcher.submit(
        { action: "getProducts" },
        { method: "GET" }
      );
    } catch (error) {
      console.error("Error fetching products:", error);
    } finally {
      setProductsLoading(false);
    }
  };

  useEffect(() => {
    fetchGoldPrice();
    fetchProducts();
    const interval = setInterval(fetchGoldPrice, 300000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (fetcher.data?.products) {
      setProducts(fetcher.data.products);
    } else if (fetcher.data?.message) {
      alert(fetcher.data.message);
      if (fetcher.data.success) {
        fetchProducts();
        setPriceInput("");
        setMakingChargesInput("");
        setDiscountPriceInput("");
      }
    }
  }, [fetcher.data]);

  const handlePriceChange = (value) => setPriceInput(value);
  const handleMakingChargesChange = (value) => setMakingChargesInput(value);
  const handleDiscountPriceChange = (value) => setDiscountPriceInput(value); // New handler
  const handleDiamondPriceChange = (type, value) => {
    setDiamondPrices((prevPrices) => ({
      ...prevPrices,
      [type]: parseFloat(value) || 0,
    }));
  };

  const handleButtonClick = async () => {
    if (!priceInput || isNaN(priceInput) || parseFloat(priceInput) <= 0) {
      alert("Please enter a valid gold price");
      return;
    }

    setLoading(true);
    try {
      fetcher.submit(
        {
          price: priceInput,
          makingCharges: makingChargesInput,
          discountPrice: discountPriceInput, // Include discount
          diamondPrices: JSON.stringify(diamondPrices),
          productData: JSON.stringify(products),
        },
        { method: "POST" }
      );
    } catch (error) {
      alert("Error updating prices");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page>
      <TitleBar title="Update Prices" />
      <Layout>
        <Layout.Section variant="oneHalf">
          <Card padding="1600">
            <BlockStack gap="400">
              <Text variant="headingLg" alignment="center">
                Current Gold Price (24K)
              </Text>

              {loading && (
                <Text alignment="center">Loading gold price...</Text>
              )}

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
                <Button
                  onClick={fetchGoldPrice}
                  loading={loading}
                  disabled={loading}
                >
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
                  <TextField
                    label="Discount on Diamonds (₹)" // New discount input
                    value={discountPriceInput}
                    onChange={handleDiscountPriceChange}
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
                <Button
                  onClick={handleButtonClick}
                  loading={loading}
                  variant="primary"
                >
                  Update Prices
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

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
                          .filter(
                            (metafieldEdge) =>
                              metafieldEdge.node.namespace === "custom"
                          )
                          .map((metafieldEdge, index) => (
                            <Text
                              key={index}
                              variant="bodySm"
                              color="subdued"
                            >
                              {metafieldEdge.node.key}:{" "}
                              {metafieldEdge.node.value}
                            </Text>
                          ))}
                        {product.variants.edges.map((edge, index) => (
                          <BlockStack key={index} gap="1">
                            <Text variant="bodyMd" fontWeight="bold">
                              Variant: {edge.node.title || "No Title"}
                            </Text>
                            <Text variant="bodySm">
                              Price: ₹{edge.node.price || "N/A"}
                            </Text>
                            <Text variant="bodySm">
                              Weight:{" "}
                              {edge.node.metafield?.value
                                ? `${edge.node.metafield.value} g`
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